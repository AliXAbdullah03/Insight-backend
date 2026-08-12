const mongoose = require("mongoose");

const boxSchema = new mongoose.Schema(
  {
    x1: Number,
    y1: Number,
    x2: Number,
    y2: Number,
    confidence: Number,
    label: String,
  },
  { _id: false }
);

const garageEventSchema = new mongoose.Schema(
  {
    org_id: { type: String, index: true, default: null },
    org_token: { type: String, index: true, default: null },
    org_name: { type: String, default: null },
    alert_id: {
      type: String,
      required: true,
      index: true,
    },
    channel: {
      type: String,
      required: true,
      default: "garage_monitoring",
    },
    action: {
      type: String,
      required: true,
      default: "show_instant_popup",
    },
    priority: {
      type: String,
      default: "immediate",
    },
    severity: {
      type: String,
      enum: ["critical", "high", "medium", "low"],
      default: "high",
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    camera_id: { type: String, required: true },
    event_type: {
      type: String,
      enum: ["fight", "smoking"],
      required: true,
    },
    status: {
      type: String,
      default: "not_working",
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    details: {
      track_key: { type: String, default: null },
      away_seconds: { type: Number, default: null },
      local_snapshot: { type: String, default: null },
      snapshot_saved: { type: Boolean, default: false },
      boxes: { type: [boxSchema], default: [] },
      box_count: { type: Number, default: 0 },
    },
    ui: {
      show_popup: { type: Boolean, default: true },
      sound: { type: Boolean, default: true },
      vibration: { type: Boolean, default: true },
      fullscreen_critical: { type: Boolean, default: false },
      color: { type: String, default: "#FF8C00" },
    },
    read: { type: Boolean, default: false, index: true },
    read_at: { type: Date, default: null },
    delivered_at: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "garage_events",
  }
);

garageEventSchema.index({ org_token: 1, alert_id: 1 }, { unique: true });

module.exports = mongoose.model("GarageEvent", garageEventSchema);
