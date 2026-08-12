const {
  extractOrgToken,
  findActiveOrganizationByToken,
  toPublicOrg,
} = require("../services/org.service");
const { statusCodeTemplate } = require("../utils/api.utils");

/**
 * Requires a valid active organization token via:
 * Authorization: Bearer <org_token>  OR  X-Org-Token: <org_token>
 * Attaches req.org and req.orgToken.
 */
async function requireOrgToken(req, res, next) {
  try {
    const token = extractOrgToken(req);
    if (!token) {
      return statusCodeTemplate(res, 401, "Organization token missing.");
    }

    const org = await findActiveOrganizationByToken(token);
    if (!org) {
      return statusCodeTemplate(res, 403, "Invalid or inactive organization token.");
    }

    req.orgToken = token;
    req.org = org;
    req.publicOrg = toPublicOrg(org);
    return next();
  } catch (error) {
    console.error("requireOrgToken error:", error);
    return statusCodeTemplate(res, 500, "Failed to validate organization token.");
  }
}

module.exports = { requireOrgToken };
