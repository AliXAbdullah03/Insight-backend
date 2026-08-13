const {
  extractOrgToken,
  findActiveOrganizationByToken,
  toPublicOrg,
  rejectInvalidOrgToken,
  omitOrgSecrets,
  findScopedDocs,
} = require("../services/org.service");
const {
  fetchAiViolations,
  fetchAiCameraStatus,
  fetchAiPersons,
  fetchAiDashboard,
  fetchAiToday,
  fetchAiEmployees,
  fetchAiEmployee,
  fetchAiMedia,
} = require("../services/aiProxy.service");
const { generateOrgInsights } = require("../services/inklingInsights.service");
const Organization = require("../models/organization.model");
const OrgToken = require("../models/orgToken.model");
const Violation = require("../models/violation.model");
const GarageCameraStatus = require("../models/garageCameraStatus.model");
const { statusCodeTemplate, catchTemplate } = require("../utils/api.utils");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function generateOrgToken() {
  return `org_${crypto.randomBytes(24).toString("hex")}`;
}

function verifyAdminOrgAccess(req, res) {
  const expected = process.env.MOBILE_BACKEND_TOKEN;
  if (!expected) return true;
  const header =
    req.headers["x-mobile-backend-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (header === expected) return true;
  statusCodeTemplate(res, 403, "Admin organization access denied.");
  return false;
}

async function requireValidOrg(req, res) {
  const token = extractOrgToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      message: "Organization token missing.",
    });
  }
  const org = await findActiveOrganizationByToken(token);
  if (!org) {
    rejectInvalidOrgToken(res);
    return null;
  }
  return { token, org };
}

async function tryAiThenMongo({
  token,
  aiCall,
  pickBody,
  collection,
  sort,
  limit,
}) {
  try {
    const ai = await aiCall();
    if (ai.status >= 200 && ai.status < 300 && ai.body) {
      const picked = pickBody ? pickBody(ai.body) : ai.body;
      if (picked != null) return { fromAi: true, body: ai.body, picked };
    }
  } catch (proxyError) {
    console.error("Garage AI proxy skipped:", proxyError.message);
  }

  const rows = await findScopedDocs(collection, token, { sort, limit });
  return { fromAi: false, rows };
}

/** POST /api/auth/org-token  { token } — Mongo org_tokens */
const connectOrgToken = async (req, res) => {
  try {
    const token = String(req.body?.token || req.body?.org_token || "").trim();
    if (!token) {
      return statusCodeTemplate(res, 400, "Missing required field: token");
    }
    if (/^https?:\/\//i.test(token)) {
      return statusCodeTemplate(
        res,
        403,
        "That is a URL, not an organization token. Paste the org_… value."
      );
    }

    const org = await findActiveOrganizationByToken(token);
    const storedSample = org
      ? null
      : await OrgToken.findOne({}, { token: 1 }).lean();
    console.log(
      `org-token connect: org_tokens match=${Boolean(org)} source=${org?.source || "none"} name=${org?.name || "n/a"} pastedLen=${token.length} storedLen=${org ? token.length : (storedSample?.token || "").length} startsWithOrg_=${token.startsWith("org_")}`
    );
    if (!org) {
      return rejectInvalidOrgToken(res);
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

/** GET /mobile/me and GET /api/org/me */
const getOrgMe = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const publicOrg = toPublicOrg(auth.org);
    return res.status(200).json({
      ok: true,
      organization: publicOrg,
      org_id: publicOrg.org_id,
      name: publicOrg.name,
      org_name: publicOrg.name,
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

function safeSnapshotRel(raw) {
  const rel = String(raw || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!rel || rel.includes("..") || /:\/\//.test(rel)) return null;
  return rel;
}

function snapshotRelFromDoc(row) {
  const raw = String(
    row?.local_snapshot || row?.snapshot || row?.image_url || row?.snapshot_url || ""
  ).replace(/\\/g, "/");
  const idx = raw.toLowerCase().indexOf("snapshots/");
  if (idx >= 0) return safeSnapshotRel(raw.slice(idx));
  return safeSnapshotRel(raw);
}

function publicSnapshotUrl(rel) {
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  return `/api/mobile/media?path=${encodeURIComponent(rel)}`;
}

function withSnapshotUrl(row) {
  const rel = snapshotRelFromDoc(row);
  if (!rel) return omitOrgSecrets(row);
  return {
    ...omitOrgSecrets(row),
    local_snapshot: rel,
    snapshot_url: publicSnapshotUrl(rel),
  };
}

/** GET /mobile/violations?limit=50 */
const listViolations = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;
    const limit = Math.min(Number(req.query.limit) || 50, 1000);

    const result = await tryAiThenMongo({
      token,
      aiCall: () => fetchAiViolations(token, limit),
      pickBody: (body) => body.violations || body.events || null,
      collection: "violations",
      sort: { timestamp: -1 },
      limit,
    });

    if (result.fromAi) {
      const violations = (
        result.body.violations ||
        result.body.events ||
        result.picked ||
        []
      ).map(withSnapshotUrl);
      return res.status(200).json({
        ok: true,
        violations,
        organization: toPublicOrg(org),
      });
    }

    const rows =
      result.rows && result.rows.length
        ? result.rows
        : (
            await Violation.find({ org_token: token })
              .sort({ timestamp: -1 })
              .limit(limit)
              .lean()
          );

    return res.status(200).json({
      ok: true,
      violations: rows.map(withSnapshotUrl),
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/snapshots?limit=12 */
const listSnapshots = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;
    const limit = Math.min(Number(req.query.limit) || 12, 50);

    const rows = await findScopedDocs("violations", token, {
      extra: {
        local_snapshot: { $exists: true, $nin: [null, ""] },
      },
      sort: { timestamp: -1 },
      limit: Math.max(limit * 4, 80),
    });

    const snapshots = [];
    const seen = new Set();
    for (const row of rows) {
      const rel = snapshotRelFromDoc(row);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      snapshots.push({
        path: rel,
        event_type: row.event_type || row.type || null,
        camera_id: row.camera_id || null,
        camera_name: row.camera_name || row.camera_id || null,
        timestamp: row.timestamp || row.created_at || null,
        image_url: publicSnapshotUrl(rel),
      });
      if (snapshots.length >= limit) break;
    }

    return res.status(200).json({
      ok: true,
      snapshots,
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/media?path=snapshots/cam_1/file.jpg */
const proxyMedia = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token } = auth;
    const rel = safeSnapshotRel(req.query.path);
    if (!rel) {
      return statusCodeTemplate(res, 400, "Invalid snapshot path.");
    }

    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const owned = await findScopedDocs("violations", token, {
      extra: {
        $or: [
          { local_snapshot: rel },
          { local_snapshot: { $regex: `${escaped}$` } },
        ],
      },
      limit: 1,
    });
    if (!owned.length) {
      return statusCodeTemplate(
        res,
        404,
        "Snapshot not found for this organization."
      );
    }

    const localRoot = process.env.SNAPSHOTS_DIR;
    if (localRoot) {
      const abs = path.resolve(localRoot, rel);
      const rootAbs = path.resolve(localRoot);
      if (abs.startsWith(rootAbs) && fs.existsSync(abs)) {
        res.setHeader("Cache-Control", "private, max-age=300");
        return res.sendFile(abs);
      }
    }

    const remote = await fetchAiMedia(rel, token);
    if (remote) {
      res.setHeader("Content-Type", remote.contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.status(200).send(remote.buffer);
    }

    return statusCodeTemplate(res, 404, "Snapshot image is not available.");
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/status */
const listOrgCameraStatus = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;

    const result = await tryAiThenMongo({
      token,
      aiCall: () => fetchAiCameraStatus(token),
      pickBody: (body) =>
        body.cameras || body.camera_status || body.status || null,
      collection: "camera_status",
      sort: { last_seen_at: -1 },
      limit: 200,
    });

    if (result.fromAi) {
      return res.status(200).json({
        ok: true,
        cameras:
          result.body.cameras ||
          result.body.camera_status ||
          result.body.status ||
          result.picked ||
          [],
        organization: toPublicOrg(org),
      });
    }

    const rows =
      result.rows && result.rows.length
        ? result.rows
        : (
            await GarageCameraStatus.find({ org_token: token })
              .sort({ last_seen_at: -1 })
              .lean()
          ).map(omitOrgSecrets);

    return res.status(200).json({
      ok: true,
      cameras: rows,
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/persons */
const listPersons = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;

    const result = await tryAiThenMongo({
      token,
      aiCall: () => fetchAiPersons(token),
      pickBody: (body) => body.persons || body.people || body.staff || null,
      collection: "person_identities",
      sort: { updated_at: -1 },
      limit: 500,
    });

    const persons = result.fromAi
      ? result.body.persons ||
        result.body.people ||
        result.body.staff ||
        result.picked ||
        []
      : result.rows;

    return res.status(200).json({
      ok: true,
      persons,
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/analytics/dashboard */
const getAnalyticsDashboard = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;

    try {
      const ai = await fetchAiDashboard(token);
      if (ai.status >= 200 && ai.status < 300 && ai.body) {
        return res.status(200).json({
          ok: true,
          ...ai.body,
          organization: toPublicOrg(org),
        });
      }
    } catch (proxyError) {
      console.error("AI dashboard proxy skipped:", proxyError.message);
    }

    const [today] = await findScopedDocs("daily_analytics", token, {
      sort: { date: -1 },
      limit: 1,
    });
    const insights = await findScopedDocs("insights", token, {
      sort: { created_at: -1 },
      limit: 20,
    });

    return res.status(200).json({
      ok: true,
      dashboard: today || {},
      insights,
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/analytics/today */
const getAnalyticsToday = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;

    try {
      const ai = await fetchAiToday(token);
      if (ai.status >= 200 && ai.status < 300 && ai.body) {
        return res.status(200).json({
          ok: true,
          ...ai.body,
          organization: toPublicOrg(org),
        });
      }
    } catch (proxyError) {
      console.error("AI today proxy skipped:", proxyError.message);
    }

    const rows = await findScopedDocs("daily_analytics", token, {
      sort: { date: -1 },
      limit: 1,
    });

    return res.status(200).json({
      ok: true,
      today: rows[0] || {},
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/analytics/history?days=30 */
const listDailyAnalytics = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);

    const rows = await findScopedDocs("daily_analytics", token, {
      sort: { date: -1 },
      limit: days,
    });

    return res.status(200).json({
      ok: true,
      days: rows,
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/analytics/employees */
const listEmployees = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;

    try {
      const ai = await fetchAiEmployees(token);
      if (ai.status >= 200 && ai.status < 300 && ai.body) {
        return res.status(200).json({
          ok: true,
          employees:
            ai.body.employees || ai.body.staff || ai.body.persons || [],
          organization: toPublicOrg(org),
        });
      }
    } catch (proxyError) {
      console.error("AI employees proxy skipped:", proxyError.message);
    }

    let employees = await findScopedDocs("employee_profiles", token, {
      sort: { name: 1 },
      limit: 500,
    });
    if (!employees.length) {
      employees = await findScopedDocs("person_identities", token, {
        sort: { name: 1 },
        limit: 500,
      });
    }

    return res.status(200).json({
      ok: true,
      employees,
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/analytics/employees/:person_id */
const getEmployeeProfile = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;
    const personId = String(req.params.person_id || "").trim();
    if (!personId) {
      return statusCodeTemplate(res, 400, "Missing person_id");
    }

    try {
      const ai = await fetchAiEmployee(token, personId);
      if (ai.status >= 200 && ai.status < 300 && ai.body) {
        return res.status(200).json({
          ok: true,
          employee: ai.body.employee || ai.body,
          organization: toPublicOrg(org),
        });
      }
    } catch (proxyError) {
      console.error("AI employee proxy skipped:", proxyError.message);
    }

    const extra = {
      $or: [
        { person_id: personId },
        { employee_id: personId },
        { track_id: personId },
      ],
    };
    const [profile] =
      (await findScopedDocs("employee_profiles", token, {
        extra,
        limit: 1,
      })) || [];
    const [person] =
      profile
        ? [profile]
        : await findScopedDocs("person_identities", token, {
            extra,
            limit: 1,
          });

    if (!person) {
      return statusCodeTemplate(res, 404, "Employee not found for this organization.");
    }

    return res.status(200).json({
      ok: true,
      employee: person,
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

/** GET /mobile/analytics/insights */
const listInsights = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token, org } = auth;

    const generated = await generateOrgInsights(token, org);
    if (generated?.insights?.length) {
      return res.status(200).json({
        ok: true,
        insights: generated.insights,
        cached: Boolean(generated.cached),
        organization: toPublicOrg(org),
      });
    }

    const insights = await findScopedDocs("insights", token, {
      sort: { created_at: -1 },
      limit: 50,
    });

    return res.status(200).json({
      ok: true,
      insights,
      organization: toPublicOrg(org),
    });
  } catch (error) {
    return catchTemplate(res, error);
  }
};

async function upsertOrgTokenRow({ org_id, name, token, active = true }) {
  await OrgToken.findOneAndUpdate(
    { $or: [{ token }, { org_id }] },
    { org_id, name, org_name: name, token, active },
    { upsert: true, new: true }
  );
}

/** POST /api/admin/organizations  { name, token? } */
const createOrganization = async (req, res) => {
  try {
    if (!verifyAdminOrgAccess(req, res)) return;

    const name = String(req.body?.name || "").trim();
    if (!name) {
      return statusCodeTemplate(res, 400, "Missing required field: name");
    }

    const providedToken = String(
      req.body?.token || req.body?.org_token || ""
    ).trim();
    if (providedToken) {
      const existing = await findActiveOrganizationByToken(providedToken);
      if (existing) {
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
    await upsertOrgTokenRow({ org_id, name, token, active: true });

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
    await upsertOrgTokenRow({
      org_id: org.org_id,
      name: org.name,
      token: org.token,
      active: org.active !== false,
    });

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
  listPersons,
  getAnalyticsDashboard,
  getAnalyticsToday,
  listDailyAnalytics,
  listEmployees,
  getEmployeeProfile,
  listInsights,
  listSnapshots,
  proxyMedia,
  createOrganization,
  rotateOrganizationToken,
};
