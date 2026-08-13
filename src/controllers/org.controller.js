const {
  extractOrgToken,
  findActiveOrganizationByToken,
  toPublicOrg,
  maskToken,
} = require("../services/org.service");
const {
  fetchAiOrganization,
  fetchAiViolations,
  fetchAiCameraStatus,
} = require("../services/aiProxy.service");
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

function publicOrgFromAi(org) {
  if (!org) return null;
  return {
    org_id: org.org_id,
    name: org.name,
    active: org.active !== false,
    token_masked: org.token_masked || maskToken(org.token),
    source: org.source || "garage_ai",
  };
}

/** POST /api/auth/org-token  { token } — validates via garage AI /mobile/me */
const connectOrgToken = async (req, res) => {
  try {
    const token = String(req.body?.token || req.body?.org_token || "").trim();
    if (!token) {
      return statusCodeTemplate(res, 400, "Missing required field: token");
    }

    // Prefer garage AI server (source of truth for org tokens).
    try {
      const ai = await fetchAiOrganization(token);
      if (ai.ok) {
        return res.status(200).json({
          ok: true,
          organization: publicOrgFromAi(ai.organization),
          message: "Organization connected.",
        });
      }
      if (ai.status === 401 || ai.status === 403) {
        return statusCodeTemplate(res, 403, "Invalid organization token");
      }
    } catch (proxyError) {
      console.error("AI org proxy failed:", proxyError.message);
      // Fall through to local Mongo lookup.
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

/** GET /api/org/me — proxy garage AI /mobile/me */
const getOrgMe = async (req, res) => {
  try {
    const token = extractOrgToken(req);
    if (!token) {
      return statusCodeTemplate(res, 401, "Organization token missing.");
    }

    try {
      const ai = await fetchAiOrganization(token);
      if (ai.ok) {
        return res.status(200).json({
          organization: publicOrgFromAi(ai.organization),
        });
      }
      if (ai.status === 401 || ai.status === 403) {
        return statusCodeTemplate(
          res,
          ai.status,
          "Invalid or inactive organization token."
        );
      }
    } catch (proxyError) {
      console.error("AI /mobile/me proxy failed:", proxyError.message);
    }

    const org = await findActiveOrganizationByToken(token);
    if (!org) {
      return statusCodeTemplate(
        res,
        403,
        "Invalid or inactive organization token."
      );
    }
    return res.status(200).json({ organization: toPublicOrg(org) });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /api/violations?limit=50 — prefer garage AI Mongo violations */
const listViolations = async (req, res) => {
  try {
    const token = extractOrgToken(req);
    if (!token) {
      return statusCodeTemplate(res, 401, "Organization token missing.");
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    try {
      const ai = await fetchAiViolations(token, limit);
      if (ai.status >= 200 && ai.status < 300) {
        return res.status(200).json({
          violations: ai.body?.violations || ai.body?.events || [],
          organization: ai.body?.org_name
            ? { name: ai.body.org_name, org_id: ai.body.org_id }
            : undefined,
        });
      }
      if (ai.status === 401 || ai.status === 403) {
        return statusCodeTemplate(res, ai.status, "Invalid organization token");
      }
    } catch (proxyError) {
      console.error("AI violations proxy failed:", proxyError.message);
    }

    const rows = await Violation.find({ org_token: token })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      violations: rows.map(omitToken),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /api/status — prefer garage AI camera_status */
const listOrgCameraStatus = async (req, res) => {
  try {
    const token = extractOrgToken(req);
    if (!token) {
      return statusCodeTemplate(res, 401, "Organization token missing.");
    }

    try {
      const ai = await fetchAiCameraStatus(token);
      if (ai.status >= 200 && ai.status < 300) {
        return res.status(200).json({
          cameras:
            ai.body?.cameras ||
            ai.body?.camera_status ||
            ai.body?.status ||
            [],
          organization: ai.body?.org_name
            ? { name: ai.body.org_name, org_id: ai.body.org_id }
            : undefined,
        });
      }
      if (ai.status === 401 || ai.status === 403) {
        return statusCodeTemplate(res, ai.status, "Invalid organization token");
      }
    } catch (proxyError) {
      console.error("AI status proxy failed:", proxyError.message);
    }

    const cameras = await GarageCameraStatus.find({
      org_token: token,
    })
      .sort({ last_seen_at: -1 })
      .lean();

    return res.status(200).json({
      cameras: cameras.map(omitToken),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** POST /api/admin/organizations  { name, token? } — garage/admin seed helper */
const createOrganization = async (req, res) => {
  try {
    if (!verifyAdminOrgAccess(req, res)) return;

    const name = String(req.body?.name || "").trim();
    if (!name) {
      return statusCodeTemplate(res, 400, "Missing required field: name");
    }

    const providedToken = String(req.body?.token || req.body?.org_token || "").trim();
    if (providedToken) {
      const existing = await Organization.findOne({ token: providedToken });
      if (existing) {
        if (!existing.active) {
          existing.active = true;
          if (name) existing.name = name;
          await existing.save();
        }
        return res.status(200).json({
          organization: {
            org_id: existing.org_id,
            name: existing.name,
            token: existing.token,
            active: existing.active,
          },
          message: "Organization already registered; token is active.",
        });
      }
    }

    const org_id =
      String(req.body?.org_id || "").trim() || crypto.randomUUID();
    const token = providedToken || generateOrgToken();
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
    if (error?.code === 11000) {
      return statusCodeTemplate(
        res,
        409,
        "Organization with this token or org_id already exists."
      );
    }
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
