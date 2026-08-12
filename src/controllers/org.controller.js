const {
  extractOrgToken,
  findActiveOrganizationByToken,
  toPublicOrg,
  maskToken,
} = require("../services/org.service");
const Organization = require("../models/organization.model");
const Violation = require("../models/violation.model");
const GarageCameraStatus = require("../models/garageCameraStatus.model");
const { statusCodeTemplate, catchTemplate } = require("../utils/api.utils");
const crypto = require("crypto");

function omitToken(doc) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  delete obj.org_token;
  delete obj.token;
  return obj;
}

function generateOrgToken() {
  return `org_${crypto.randomBytes(24).toString("hex")}`;
}

function verifyAdminOrgAccess(req, res) {
  const expected = process.env.MOBILE_BACKEND_TOKEN;
  if (!expected) {
    // Local/dev: allow when no shared secret is configured.
    return true;
  }
  const header =
    req.headers["x-mobile-backend-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (header === expected) return true;
  statusCodeTemplate(res, 403, "Admin organization access denied.");
  return false;
}

/** POST /api/auth/org-token  { token } */
const connectOrgToken = async (req, res) => {
  try {
    const token = String(req.body?.token || req.body?.org_token || "").trim();
    if (!token) {
      return statusCodeTemplate(res, 400, "Missing required field: token");
    }

    const org = await findActiveOrganizationByToken(token);
    if (!org) {
      return statusCodeTemplate(res, 403, "Invalid organization token");
    }

    return res.status(200).json({
      ok: true,
      organization: toPublicOrg(org),
      message: "Organization connected.",
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /api/org/me */
const getOrgMe = async (req, res) => {
  try {
    return res.status(200).json({
      organization: req.publicOrg,
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /api/violations?limit=50 */
const listViolations = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await Violation.find({ org_token: req.orgToken })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      violations: rows.map(omitToken),
      organization: req.publicOrg,
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /api/status — org-scoped camera status */
const listOrgCameraStatus = async (req, res) => {
  try {
    const cameras = await GarageCameraStatus.find({
      org_token: req.orgToken,
    })
      .sort({ last_seen_at: -1 })
      .lean();

    return res.status(200).json({
      cameras: cameras.map(omitToken),
      organization: req.publicOrg,
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** POST /api/admin/organizations  { name } — garage/admin seed helper */
const createOrganization = async (req, res) => {
  try {
    if (!verifyAdminOrgAccess(req, res)) return;

    const name = String(req.body?.name || "").trim();
    if (!name) {
      return statusCodeTemplate(res, 400, "Missing required field: name");
    }

    const org_id = crypto.randomUUID();
    const token = generateOrgToken();
    const organization = await Organization.create({
      org_id,
      name,
      token,
      active: true,
    });

    return res.status(201).json({
      organization: {
        org_id: organization.org_id,
        name: organization.name,
        token: organization.token,
        active: organization.active,
      },
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** POST /api/admin/organizations/:org_id/rotate-token */
const rotateOrganizationToken = async (req, res) => {
  try {
    if (!verifyAdminOrgAccess(req, res)) return;

    const orgId = req.params.org_id;
    const org = await Organization.findOne({ org_id: orgId });
    if (!org) {
      return statusCodeTemplate(res, 404, "Organization not found");
    }

    org.token = generateOrgToken();
    await org.save();

    return res.status(200).json({
      organization: {
        org_id: org.org_id,
        name: org.name,
        token: org.token,
        active: org.active,
      },
      message: "Token rotated. Previous token is invalid immediately.",
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

module.exports = {
  connectOrgToken,
  getOrgMe,
  listViolations,
  listOrgCameraStatus,
  createOrganization,
  rotateOrganizationToken,
  extractOrgToken,
  findActiveOrganizationByToken,
  maskToken,
};
