const GarageEvent = require("../models/garageEvent.model");
const GarageCameraStatus = require("../models/garageCameraStatus.model");
const { garageAlertHub } = require("../services/garageAlert.hub");
const {
  sendGarageAlertPush,
  registerDeviceToken,
} = require("../services/pushNotification.service");
const {
  extractOrgToken,
  findActiveOrganizationByToken,
  rejectInvalidOrgToken,
} = require("../services/org.service");
const { statusCodeTemplate, catchTemplate } = require("../utils/api.utils");

const ALLOWED_CHANNELS = new Set(["garage_monitoring"]);
const ALLOWED_ACTIONS = new Set(["show_instant_popup"]);
const ALLOWED_EVENT_TYPES = new Set(["fight", "smoking"]);

function toPublicAlert(doc) {
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    alert_id: obj.alert_id,
    org_id: obj.org_id || null,
    org_name: obj.org_name || null,
    // Never expose org_token to clients
    channel: obj.channel,
    action: obj.action,
    priority: obj.priority,
    severity: obj.severity,
    title: obj.title,
    message: obj.message,
    camera_id: obj.camera_id,
    event_type: obj.event_type,
    status: obj.status,
    timestamp:
      obj.timestamp instanceof Date
        ? obj.timestamp.toISOString()
        : obj.timestamp,
    details: obj.details || {},
    ui: obj.ui || {},
    read: Boolean(obj.read),
    read_at:
      obj.read_at instanceof Date
        ? obj.read_at.toISOString()
        : obj.read_at || null,
    created_at:
      obj.createdAt instanceof Date
        ? obj.createdAt.toISOString()
        : obj.createdAt || null,
  };
}

function normalizeIncomingAlert(body, org) {
  const eventType = String(body.event_type || "").toLowerCase();
  const isFight = eventType === "fight";
  const isCritical =
    body.severity === "critical" ||
    body.ui?.fullscreen_critical === true ||
    isFight;

  const details = body.details || {};
  const boxes = Array.isArray(details.boxes) ? details.boxes : [];

  return {
    org_id: org.org_id,
    org_token: org.token,
    org_name: org.name,
    alert_id: body.alert_id,
    channel: body.channel || "garage_monitoring",
    action: body.action || "show_instant_popup",
    priority: body.priority || "immediate",
    severity: body.severity || (isFight ? "critical" : "high"),
    title:
      body.title ||
      (isFight
        ? "FIRE ALERT — Fight Detected"
        : "ALERT — Smoking Detected"),
    message:
      body.message ||
      (isFight
        ? "A fight was detected on a garage camera. Open the app immediately."
        : "Smoking was detected on a garage camera. Open the app immediately."),
    camera_id: body.camera_id,
    event_type: eventType,
    status: body.status || "not_working",
    timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
    details: {
      track_key: details.track_key ?? null,
      away_seconds: details.away_seconds ?? null,
      local_snapshot: details.local_snapshot ?? null,
      snapshot_saved: Boolean(details.snapshot_saved),
      boxes,
      box_count:
        typeof details.box_count === "number" ? details.box_count : boxes.length,
    },
    ui: {
      show_popup: body.ui?.show_popup !== false,
      sound: body.ui?.sound !== false,
      vibration: body.ui?.vibration !== false,
      fullscreen_critical: body.ui?.fullscreen_critical === true || isCritical,
      color: body.ui?.color || (isFight ? "#FF1E1E" : "#FF8C00"),
    },
    read: false,
    read_at: null,
  };
}

const receiveGarageAlert = async (req, res) => {
  try {
    const body = req.body || {};
    const channel = body.channel;
    const action = body.action;
    const eventType = String(body.event_type || "").toLowerCase();

    if (!ALLOWED_CHANNELS.has(channel) || !ALLOWED_ACTIONS.has(action)) {
      return statusCodeTemplate(
        res,
        400,
        'Accept only channel "garage_monitoring" and action "show_instant_popup".'
      );
    }

    if (!ALLOWED_EVENT_TYPES.has(eventType)) {
      return statusCodeTemplate(
        res,
        400,
        'event_type must be "fight" or "smoking".'
      );
    }

    if (!body.alert_id || !body.camera_id) {
      return statusCodeTemplate(
        res,
        400,
        "Missing required field(s): alert_id, camera_id"
      );
    }

    const orgToken = extractOrgToken(req);
    if (!orgToken) {
      return statusCodeTemplate(res, 401, "Organization token missing.");
    }

    const org = await findActiveOrganizationByToken(orgToken);
    if (!org) {
      return rejectInvalidOrgToken(res);
    }

    const normalized = normalizeIncomingAlert(body, org);

    const existing = await GarageEvent.findOne({
      org_token: org.token,
      alert_id: normalized.alert_id,
    }).lean();

    if (existing) {
      return res.status(200).json({
        ok: true,
        duplicate: true,
        alert_id: existing.alert_id,
        message: "Alert already accepted.",
      });
    }

    const saved = await GarageEvent.create(normalized);

    await GarageCameraStatus.findOneAndUpdate(
      { org_token: org.token, camera_id: normalized.camera_id },
      {
        org_id: org.org_id,
        org_token: org.token,
        org_name: org.name,
        camera_id: normalized.camera_id,
        status: normalized.status,
        last_event_type: normalized.event_type,
        last_alert_id: normalized.alert_id,
        last_seen_at: normalized.timestamp,
        severity: normalized.severity,
      },
      { upsert: true, new: true }
    );

    const publicAlert = toPublicAlert(saved);
    // Keep org_token only in-memory for hub/push scoping — not in client payload.
    const deliveryAlert = { ...publicAlert, org_token: org.token };

    garageAlertHub.broadcast(deliveryAlert, org.token);
    setImmediate(() => {
      sendGarageAlertPush(deliveryAlert).catch((err) => {
        console.error("Garage push error:", err.message);
      });
    });

    return res.status(200).json({
      ok: true,
      duplicate: false,
      alert_id: publicAlert.alert_id,
      org_id: org.org_id,
      message: "Alert accepted.",
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(200).json({
        ok: true,
        duplicate: true,
        alert_id: req.body?.alert_id,
        message: "Alert already accepted.",
      });
    }
    return catchTemplate(res, error);
  }
};

/** GET /alerts?limit=50 — org-scoped */
const listAlerts = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const events = await GarageEvent.find({ org_token: req.orgToken })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    const alerts = events.map(toPublicAlert);
    return res.status(200).json({
      alerts,
      events: alerts,
      unread_count: await GarageEvent.countDocuments({
        org_token: req.orgToken,
        read: false,
      }),
      organization: req.publicOrg,
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

const listGarageEvents = listAlerts;

const getAlertById = async (req, res) => {
  try {
    const alertId = req.params.alert_id;
    const event = await GarageEvent.findOne({
      org_token: req.orgToken,
      alert_id: alertId,
    }).lean();
    if (!event) {
      return statusCodeTemplate(res, 404, "Alert not found.");
    }
    return res.status(200).json({ alert: toPublicAlert(event) });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

const markAlertRead = async (req, res) => {
  try {
    const alertId = req.params.alert_id;
    const event = await GarageEvent.findOneAndUpdate(
      { org_token: req.orgToken, alert_id: alertId },
      { $set: { read: true, read_at: new Date() } },
      { new: true }
    ).lean();

    if (!event) {
      return statusCodeTemplate(res, 404, "Alert not found.");
    }

    return res.status(200).json({
      ok: true,
      alert: toPublicAlert(event),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

const listLiveAlerts = async (req, res) => {
  try {
    const afterRaw = req.query.after;
    const filter = { org_token: req.orgToken };

    if (afterRaw) {
      const after = new Date(afterRaw);
      if (!Number.isNaN(after.getTime())) {
        filter.timestamp = { $gt: after };
      }
    } else {
      filter.timestamp = { $gt: new Date(Date.now() - 2 * 60 * 1000) };
    }

    const events = await GarageEvent.find(filter)
      .sort({ timestamp: 1 })
      .limit(50)
      .lean();

    return res.status(200).json({
      alerts: events.map(toPublicAlert),
      server_time: new Date().toISOString(),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

const listCameraStatus = async (req, res) => {
  try {
    const cameras = await GarageCameraStatus.find({
      org_token: req.orgToken,
    })
      .sort({ last_seen_at: -1 })
      .lean();

    const sanitized = cameras.map((c) => {
      const { org_token, ...rest } = c;
      return rest;
    });

    return res.status(200).json({ cameras: sanitized });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** SSE — only events for this org token */
const streamAlerts = (req, res) => {
  const orgToken = req.orgToken;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const onAlert = (alert) => {
    const { org_token, ...publicPayload } = alert;
    res.write(`event: alert\ndata: ${JSON.stringify(publicPayload)}\n\n`);
  };

  garageAlertHub.on(`alert:${orgToken}`, onAlert);

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    garageAlertHub.off(`alert:${orgToken}`, onAlert);
  });
};

const registerPushToken = async (req, res) => {
  try {
    const { token, platform, userId, role } = req.body || {};
    if (!token) {
      return statusCodeTemplate(res, 400, "Missing required field: token");
    }

    const saved = await registerDeviceToken({
      token,
      platform,
      userId,
      role,
      orgId: req.org?.org_id,
      orgToken: req.orgToken,
    });

    return res.status(200).json({
      ok: true,
      token: saved.token,
      org_id: req.org?.org_id,
      topic: `garage_alerts_${req.org?.org_id}`,
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

module.exports = {
  receiveGarageAlert,
  listAlerts,
  listGarageEvents,
  getAlertById,
  markAlertRead,
  listLiveAlerts,
  listCameraStatus,
  streamAlerts,
  registerPushToken,
  toPublicAlert,
};
