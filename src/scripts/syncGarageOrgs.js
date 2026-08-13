require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const mongoose = require("mongoose");
const connectDB = require("../db");
const Organization = require("../models/organization.model");
const { aiBackendBase } = require("../services/aiProxy.service");
const { maskToken } = require("../services/org.service");

/**
 * Copy garage AI organizations (including token) into local Mongo
 * so POST /api/auth/org-token can verify against organizations.token.
 * Does not print full tokens.
 */
const run = async () => {
  await connectDB();
  const url = `${aiBackendBase()}/admin/organizations?reveal=true`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "InsightBackend/1.0" },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Garage org sync failed: HTTP ${response.status}`);
  }

  const rows = body.organizations || (body.organization ? [body.organization] : []);
  let upserts = 0;
  for (const row of rows) {
    const token = String(row.token || "").trim();
    if (!token || !row.org_id || !row.name) continue;
    await Organization.findOneAndUpdate(
      { org_id: row.org_id },
      {
        org_id: row.org_id,
        name: row.name,
        token,
        active: row.active !== false,
      },
      { upsert: true, new: true }
    );
    upserts += 1;
    console.log(`Upserted ${row.name} (${maskToken(token)}) active=${row.active !== false}`);
  }

  const count = await Organization.countDocuments();
  console.log(`organizations collection now has ${count} row(s); upserted ${upserts}.`);
};

run()
  .catch((error) => {
    console.error("Garage org sync failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
