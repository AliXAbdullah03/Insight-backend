const mongoose = require("mongoose");

const deviceTokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ["android", "ios", "web", "unknown"],
      default: "unknown",
    },
    org_id: {
      type: String,
      default: null,
      index: true,
    },
    org_token: {
      type: String,
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    role: {
      type: String,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    collection: "device_tokens",
  }
);

module.exports = mongoose.model("DeviceToken", deviceTokenSchema);
