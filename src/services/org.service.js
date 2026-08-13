const mongoose = require("mongoose");
const Organization = require("../models/organization.model");
const OrgToken = require("../models/orgToken.model");

const INVALID_ORG_TOKEN_MESSAGE =
  "There is no token such as this in our database";

function maskToken(token) {
  if (!token || typeof token !== "string") return "";
  if (token.length <= 10) return "••••••••";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function extractOrgToken(req) {
  const headerToken =
    req.headers["x-org-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const bodyToken = req.body?.org_token || req.body?.token;
  const queryToken = req.query?.org_token || req.query?.token;
  const raw = headerToken || bodyToken || queryToken || "";
  return String(raw).trim();
}

function normalizeOrgDoc(doc, source, fallbackToken) {
  if (!doc) return null;
  const token = String(
    doc.token || doc.org_token || fallbackToken || ""
  ).trim();
  const name = String(
    doc.name || doc.org_name || doc.organization_name || "Organization"
  ).trim();
  const org_id = String(
    doc.org_id || doc.orgId || (doc._id ? String(doc._id) : "")
  ).trim();
  return {
    org_id,
    name,
    token,
    active: doc.active !== false,
    source,
  };
}

/**
 * Verify the pasted org_… token against Mongo `org_tokens`.
 * `organizations.token` is a legacy fallback only.
 */
async function findActiveOrganizationByToken(token) {
  const value = String(token || "").trim();
  if (!value) return null;

  const tokenFilter = {
    $or: [{ token: value }, { org_token: value }],
    active: { $ne: false },
  };

  const fromTokens = await OrgToken.findOne(tokenFilter).lean();
  if (fromTokens) {
    const normalized = normalizeOrgDoc(fromTokens, "org_tokens", value);
    if (!normalized.name || normalized.name === "Organization") {
      const named = await Organization.findOne({
        $or: [
          { org_id: normalized.org_id },
          { token: value },
        ],
      }).lean();
      if (named?.name) normalized.name = named.name;
      if (!normalized.org_id && named?.org_id) normalized.org_id = named.org_id;
    }
    return normalized;
  }

  const fromOrgs = await Organization.findOne({
    token: value,
    active: { $ne: false },
  }).lean();
  if (fromOrgs) return normalizeOrgDoc(fromOrgs, "organizations", value);

  return null;
}

function toPublicOrg(org) {
  if (!org) return null;
  return {
    org_id: org.org_id,
    name: org.name,
    org_name: org.name,
    active: org.active !== false,
    token_masked: maskToken(org.token),
  };
}

function rejectInvalidOrgToken(res, status = 403) {
  return res.status(status).json({
    ok: false,
    message: INVALID_ORG_TOKEN_MESSAGE,
  });
}

function omitOrgSecrets(doc) {
  if (!doc) return doc;
  const obj =
    typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  delete obj.org_token;
  delete obj.token;
  if (obj._id) obj._id = String(obj._id);
  return obj;
}

function scopedCollection(name) {
  if (!mongoose.connection?.db) {
    throw new Error("MongoDB is not connected.");
  }
  return mongoose.connection.db.collection(name);
}

async function findScopedDocs(collectionName, token, options = {}) {
  const { sort = { timestamp: -1 }, limit = 200, extra = {} } = options;
  const cursor = scopedCollection(collectionName).find({
    org_token: token,
    ...extra,
  });
  if (sort) cursor.sort(sort);
  if (limit) cursor.limit(limit);
  const rows = await cursor.toArray();
  return rows.map(omitOrgSecrets);
}

module.exports = {
  INVALID_ORG_TOKEN_MESSAGE,
  maskToken,
  extractOrgToken,
  findActiveOrganizationByToken,
  toPublicOrg,
  rejectInvalidOrgToken,
  omitOrgSecrets,
  scopedCollection,
  findScopedDocs,
};
