const admin = require("firebase-admin");
const DeviceToken = require("../models/deviceToken.model");

let initialized = false;

function orgTopic(orgId) {
  const safe = String(orgId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `garage_alerts_${safe}`;
}

function initFirebaseAdmin() {
  if (initialized) return true;
  if (admin.apps.length > 0) {
    initialized = true;
    return true;
  }

  try {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (json) {
      const creds = JSON.parse(json);
      admin.initializeApp({
        credential: admin.credential.cert(creds),
      });
      initialized = true;
      console.log("Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON.");
      return true;
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      initialized = true;
      console.log("Firebase Admin initialized from application default credentials.");
      return true;
    }

    console.warn(
      "Firebase Admin not configured — garage push notifications disabled. Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."
    );
    return false;
  } catch (error) {
    console.error("Firebase Admin init failed:", error.message);
    return false;
  }
}

function buildGaragePushPayload(alert) {
  const isFight = alert.event_type === "fight";
  return {
    notification: {
      title: alert.title,
      body: alert.message,
    },
    data: {
      type: "garage_alert",
      alert_id: String(alert.alert_id || ""),
      org_id: String(alert.org_id || ""),
      channel: String(alert.channel || "garage_monitoring"),
      action: String(alert.action || "show_instant_popup"),
      event_type: String(alert.event_type || ""),
      severity: String(alert.severity || ""),
      camera_id: String(alert.camera_id || ""),
      priority: String(alert.priority || "immediate"),
      color: String(alert.ui?.color || (isFight ? "#FF1E1E" : "#FF8C00")),
      fullscreen_critical: String(
        alert.ui?.fullscreen_critical === true || isFight
      ),
      click_action: "FLUTTER_NOTIFICATION_CLICK",
    },
    android: {
      priority: "high",
      notification: {
        channelId: isFight ? "garage_critical" : "garage_warning",
        priority: "max",
        defaultSound: true,
        defaultVibrateTimings: true,
        color: alert.ui?.color || (isFight ? "#FF1E1E" : "#FF8C00"),
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          badge: 1,
          contentAvailable: true,
          mutableContent: true,
          interruptionLevel: isFight ? "critical" : "time-sensitive",
        },
      },
    },
  };
}

/** Push only to devices / topic for this organization. */
async function sendGarageAlertPush(alert) {
  if (!initFirebaseAdmin()) {
    return { sent: false, reason: "firebase_not_configured" };
  }

  const orgId = alert.org_id;
  const orgToken = alert.org_token;
  if (!orgId && !orgToken) {
    return { sent: false, reason: "missing_org_scope" };
  }

  const payload = buildGaragePushPayload(alert);
  const results = { topic: null, devices: null };

  if (orgId) {
    try {
      results.topic = await admin.messaging().send({
        topic: orgTopic(orgId),
        ...payload,
      });
    } catch (error) {
      console.error("Garage org topic push failed:", error.message);
      results.topicError = error.message;
    }
  }

  try {
    const filter = { active: true };
    if (orgToken) filter.org_token = orgToken;
    else if (orgId) filter.org_id = orgId;

    const tokens = await DeviceToken.find(filter).select("token").lean();
    const tokenList = tokens.map((t) => t.token).filter(Boolean);

    if (tokenList.length > 0) {
      const response = await admin.messaging().sendEachForMulticast({
        tokens: tokenList,
        ...payload,
      });

      const invalid = [];
      response.responses.forEach((r, i) => {
        if (
          !r.success &&
          (r.error?.code === "messaging/registration-token-not-registered" ||
            r.error?.code === "messaging/invalid-registration-token")
        ) {
          invalid.push(tokenList[i]);
        }
      });
      if (invalid.length) {
        await DeviceToken.updateMany(
          { token: { $in: invalid } },
          { $set: { active: false } }
        );
      }

      results.devices = {
        successCount: response.successCount,
        failureCount: response.failureCount,
      };
    }
  } catch (error) {
    console.error("Garage device push failed:", error.message);
    results.devicesError = error.message;
  }

  return { sent: true, ...results };
}

async function registerDeviceToken({
  token,
  platform,
  userId,
  role,
  orgId,
  orgToken,
}) {
  if (!token) return null;
  return DeviceToken.findOneAndUpdate(
    { token },
    {
      token,
      platform: platform || "unknown",
      userId: userId || null,
      role: role || null,
      org_id: orgId || null,
      org_token: orgToken || null,
      active: true,
      lastSeenAt: new Date(),
    },
    { upsert: true, new: true }
  );
}

module.exports = {
  orgTopic,
  sendGarageAlertPush,
  registerDeviceToken,
  initFirebaseAdmin,
};
