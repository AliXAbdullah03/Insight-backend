const {
  extractOrgToken,
  findActiveOrganizationByToken,
  toPublicOrg,
  rejectInvalidOrgToken,
} = require("../services/org.service");

/**
 * Requires a valid active organization token via:
 * Authorization: Bearer <org_token>  OR  X-Org-Token: <org_token>
 * Lookup is Mongo `org_tokens` (active: true). No separate API key.
 */
async function requireOrgToken(req, res, next) {
  try {
    const token = extractOrgToken(req);
    if (!token) {
      return res.status(401).json({
        ok: false,
        message: "Organization token missing.",
      });
    }

    const org = await findActiveOrganizationByToken(token);
    if (!org) {
      return rejectInvalidOrgToken(res);
    }

    req.orgToken = token;
    req.org = org;
    req.publicOrg = toPublicOrg(org);
    return next();
  } catch (error) {
    console.error("requireOrgToken error:", error);
    return res.status(500).json({
      ok: false,
      message: "Failed to validate organization token.",
    });
  }
}

module.exports = { requireOrgToken };
