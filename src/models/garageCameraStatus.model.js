const mongoose = require("mongoose");

const garageCameraStatusSchema = new mongoose.Schema(
  {
    camera_id: {
      type: String,
      required: true,
      unique: true,
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
    collection: "garage_camera_status",
  }
);

module.exports = mongoose.model(
  "GarageCameraStatus",
  garageCameraStatusSchema
);
