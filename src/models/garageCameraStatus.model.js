const mongoose = require("mongoose");

const garageCameraStatusSchema = new mongoose.Schema(
  {
    org_id: { type: String, index: true, default: null },
    org_token: { type: String, index: true, default: null },
    org_name: { type: String, default: null },
    camera_id: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      default: "unknown",
    },
    last_event_type: {
      type: String,
      default: null,
    },
    last_alert_id: {
      type: String,
      default: null,
    },
    last_seen_at: {
      type: Date,
      default: Date.now,
    },
    severity: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "camera_status",
  }
);

garageCameraStatusSchema.index(
  { org_token: 1, camera_id: 1 },
  { unique: true, partialFilterExpression: { org_token: { $type: "string" } } }
);

module.exports = mongoose.model(
  "GarageCameraStatus",
  garageCameraStatusSchema
);
