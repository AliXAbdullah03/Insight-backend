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

/** Garage AI violations — scoped by org_token. */
const violationSchema = new mongoose.Schema(
  {
    org_id: { type: String, index: true },
    org_token: { type: String, index: true },
    org_name: { type: String, default: null },
    alert_id: { type: String, index: true },
    camera_id: { type: String, index: true },
    event_type: { type: String },
    status: { type: String },
    severity: { type: String },
    title: { type: String },
    message: { type: String },
    timestamp: { type: Date, index: true },
    boxes: { type: [boxSchema], default: [] },
    snapshot_saved: { type: Boolean, default: false },
    local_snapshot: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: "violations",
    strict: false,
  }
);

module.exports = mongoose.model("Violation", violationSchema);
