const mongoose = require("mongoose");

/**
 * Garage-issued organization tokens.
 * Database: insight  |  Collection: org_tokens
 */
const orgTokenSchema = new mongoose.Schema(
  {
    token: { type: String, index: true },
    org_token: { type: String, index: true },
    org_id: { type: String, index: true },
    name: { type: String },
    org_name: { type: String },
    active: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "org_tokens",
    strict: false,
  }
);

module.exports = mongoose.model("OrgToken", orgTokenSchema);
