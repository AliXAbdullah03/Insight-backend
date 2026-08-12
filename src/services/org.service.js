const Organization = require("../models/organization.model");

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

async function findActiveOrganizationByToken(token) {
  if (!token) return null;
  return Organization.findOne({ token, active: true }).lean();
}

function toPublicOrg(org) {
  if (!org) return null;
  return {
    org_id: org.org_id,
    name: org.name,
    active: org.active !== false,
    token_masked: maskToken(org.token),
  };
}

module.exports = {
  maskToken,
  extractOrgToken,
  findActiveOrganizationByToken,
  toPublicOrg,
};
