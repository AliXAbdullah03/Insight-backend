const GarageEvent = require("../models/garageEvent.model");
const GarageCameraStatus = require("../models/garageCameraStatus.model");
const { garageAlertHub } = require("../services/garageAlert.hub");
const { statusCodeTemplate, catchTemplate } = require("../utils/api.utils");

const ALLOWED_CHANNELS = new Set(["garage_monitoring"]);
const ALLOWED_ACTIONS = new Set(["show_instant_popup"]);
const ALLOWED_EVENT_TYPES = new Set(["fight", "smoking"]);

function toPublicAlert(doc) {
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    alert_id: obj.alert_id,
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
  };
}

function verifyMobileBackendToken(req, res) {
  const expected = process.env.MOBILE_BACKEND_TOKEN;
  if (!expected) {
    return true;
  }

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    statusCodeTemplate(res, 401, "Bearer Token missing.");
    return false;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (token !== expected) {
    statusCodeTemplate(res, 403, "Invalid mobile backend token.");
    return false;
  }

  return true;
}

function normalizeIncomingAlert(body) {
  const eventType = String(body.event_type || "").toLowerCase();
  const isFight = eventType === "fight";
  const isCritical =
    body.severity === "critical" ||
    body.ui?.fullscreen_critical === true ||
    isFight;

  const details = body.details || {};
  const boxes = Array.isArray(details.boxes) ? details.boxes : [];

  return {
    alert_id: body.alert_id,
    channel: body.channel || "garage_monitoring",
    action: body.action || "show_instant_popup",
    priority: body.priority || "immediate",
    severity: body.severity || (isFight ? "critical" : "high"),
    title:
      body.title ||
      (isFight
        ? "FIRE ALERT — Fight Detected"
        : "FIRE ALERT — Smoking Detected"),
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
      fullscreen_critical:
        body.ui?.fullscreen_critical === true || isCritical,
      color:
        body.ui?.color ||
        (isFight ? "#FF1E1E" : "#FF8C00"),
    },
  };
}

/**
 * Garage PC webhook:
 * POST /alerts  (or /api/alerts)
 * Content-Type: application/json
 * Authorization: Bearer {MOBILE_BACKEND_TOKEN}  // if set
 */
const receiveGarageAlert = async (req, res) => {
  try {
    if (!verifyMobileBackendToken(req, res)) {
      return;
    }

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

    const normalized = normalizeIncomingAlert(body);

    // Deduplicate by alert_id — same alert is not stored / shown twice.
    const existing = await GarageEvent.findOne({
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
      { camera_id: normalized.camera_id },
      {
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
    garageAlertHub.broadcast(publicAlert);

    // Respond quickly so the garage notifier does not block.
    return res.status(200).json({
      ok: true,
      duplicate: false,
      alert_id: publicAlert.alert_id,
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

/** GET /api/alerts/events — history for mobile notification list */
const listGarageEvents = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const events = await GarageEvent.find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      events: events.map(toPublicAlert),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/**
 * GET /api/alerts/live?after=<ISO>
 * Returns alerts newer than `after` for mobile polling.
 */
const listLiveAlerts = async (req, res) => {
  try {
    const afterRaw = req.query.after;
    const filter = {};

    if (afterRaw) {
      const after = new Date(afterRaw);
      if (!Number.isNaN(after.getTime())) {
        filter.timestamp = { $gt: after };
      }
    } else {
      // Default: last 2 minutes so a cold start still catches recent fires.
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

/** GET /api/alerts/camera-status — slim latest status per camera */
const listCameraStatus = async (req, res) => {
  try {
    const cameras = await GarageCameraStatus.find({})
      .sort({ last_seen_at: -1 })
      .lean();

    return res.status(200).json({ cameras });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/**
 * GET /api/alerts/stream — Server-Sent Events for instant in-app delivery.
 */
const streamAlerts = (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const onAlert = (alert) => {
    res.write(`event: alert\ndata: ${JSON.stringify(alert)}\n\n`);
  };

  garageAlertHub.on("alert", onAlert);

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    garageAlertHub.off("alert", onAlert);
  });
};

module.exports = {
  receiveGarageAlert,
  listGarageEvents,
  listLiveAlerts,
  listCameraStatus,
  streamAlerts,
  toPublicAlert,
};
