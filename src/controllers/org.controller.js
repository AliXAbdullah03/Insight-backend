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
  fetchAiDashboard,
  fetchAiToday,
  fetchAiMedia,
} = require("../services/aiProxy.service");
const { generateOrgInsights } = require("../services/inklingInsights.service");
const Organization = require("../models/organization.model");
const OrgToken = require("../models/orgToken.model");
const Violation = require("../models/violation.model");
const GarageCameraStatus = require("../models/garageCameraStatus.model");
const { statusCodeTemplate, catchTemplate } = require("../utils/api.utils");
const mongoose = require("mongoose");
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

function hasUsefulAiPayload(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
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
      if (hasUsefulAiPayload(picked)) {
        return { fromAi: true, body: ai.body, picked };
      }
    }
  } catch (proxyError) {
    console.error("Garage AI proxy skipped:", proxyError.message);
  }

  const rows = await findScopedDocs(collection, token, { sort, limit });
  return { fromAi: false, rows };
}

function personFromViolation(row) {
  const details =
    row?.details && typeof row.details === "object" ? row.details : {};
  const boxes = Array.isArray(row?.boxes)
    ? row.boxes
    : Array.isArray(details.boxes)
      ? details.boxes
      : [];
  const label = boxes.map((box) => box && box.label).find(Boolean);
  const personId = String(
    row?.person_id ||
      row?.employee_id ||
      row?.track_id ||
      details.track_key ||
      details.person_id ||
      label ||
      ""
  ).trim();
  if (!personId) return null;
  const name = String(
    row?.display_name ||
      row?.person_name ||
      row?.employee_name ||
      row?.name ||
      label ||
      personId
  ).trim();
  return { person_id: personId, name };
}

function scoreFromIncidents(type, count) {
  const penalty =
    type === "fight" ? 25 : type === "smoking" ? 15 : type === "phone" ? 10 : 8;
  return Math.max(0, 100 - count * penalty);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripHeavyFields(row) {
  const obj = omitOrgSecrets(row) || {};
  delete obj.embeddings;
  delete obj.enrolled_photo_jpeg;
  delete obj.payload;
  if (obj.snapshots && typeof obj.snapshots === "object") {
    const snaps = { ...obj.snapshots };
    delete snaps.jpg;
    delete snaps.jpeg;
    obj.snapshots = snaps;
  }
  delete obj["snapshots.jpg"];
  return obj;
}

function jpegBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.length > 32 ? value : null;
  if (
    value._bsontype === "Binary" ||
    (value.buffer && value.sub_type !== undefined)
  ) {
    const buf = Buffer.from(value.buffer);
    return buf.length > 32 ? buf : null;
  }
  if (Array.isArray(value) && value.length && typeof value[0] === "number") {
    const buf = Buffer.from(value);
    return buf.length > 32 ? buf : null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("data:image/")) {
      const comma = s.indexOf(",");
      if (comma < 0) return null;
      try {
        const buf = Buffer.from(s.slice(comma + 1), "base64");
        return buf.length > 32 ? buf : null;
      } catch (_) {
        return null;
      }
    }
    if (
      s.startsWith("/9j/") ||
      s.startsWith("iVBOR") ||
      /^[A-Za-z0-9+/]+=*$/.test(s.slice(0, 48))
    ) {
      try {
        const buf = Buffer.from(s, "base64");
        return buf.length > 32 ? buf : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }
  if (typeof value === "object") {
    return (
      jpegBuffer(value.jpg) ||
      jpegBuffer(value.jpeg) ||
      jpegBuffer(value.data) ||
      jpegBuffer(value.binary) ||
      jpegBuffer(value.enrolled_photo_jpeg)
    );
  }
  return null;
}

function snapshotJpegFromDoc(row) {
  if (!row) return null;
  const nested = asObject(row.snapshots);
  return (
    jpegBuffer(nested.jpg) ||
    jpegBuffer(nested.jpeg) ||
    jpegBuffer(row["snapshots.jpg"]) ||
    jpegBuffer(row.snapshots_jpg) ||
    jpegBuffer(row.jpg) ||
    jpegBuffer(row.jpeg) ||
    jpegBuffer(row.image) ||
    jpegBuffer(row.snapshot) ||
    jpegBuffer(row.frame)
  );
}

function publicMediaUrl(query) {
  const params = new URLSearchParams(query);
  return `/api/mobile/media?${params.toString()}`;
}

function jpegContentType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return "image/jpeg";
}

function sendJpeg(res, buf) {
  res.setHeader("Content-Type", jpegContentType(buf));
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).send(buf);
}

function publicBehaviorSnapshot(row) {
  if (!row) return null;
  const id = String(row._id || row.snapshot_id || "");
  const timestamp = row.timestamp || row.created_at || null;
  const cameraName = row.camera_name || row.camera_id || null;
  const eventType = row.event_type || row.kind || row.type || null;
  const personId = row.person_id || row.employee_id || null;
  if (id && snapshotJpegFromDoc(row)) {
    return {
      id,
      image_url: publicMediaUrl({ kind: "snapshot", id }),
      timestamp,
      camera_name: cameraName,
      event_type: eventType,
      person_id: personId,
    };
  }
  const rel = snapshotRelFromDoc(row);
  if (!rel) return null;
  return {
    id: id || rel,
    path: rel,
    image_url: publicSnapshotUrl(rel),
    timestamp,
    camera_name: cameraName,
    event_type: eventType,
    person_id: personId,
  };
}

function personKey(row) {
  return String(row?.person_id || row?.employee_id || row?.track_id || "").trim();
}

function publicEmployee(row) {
  const hasPhoto = Boolean(
    row?.has_enrolled_photo ||
      jpegBuffer(row?.enrolled_photo_jpeg) ||
      jpegBuffer(asObject(row?.identity).enrolled_photo_jpeg)
  );
  const raw = stripHeavyFields(row);
  const scores = asObject(raw.scores);
  const incidents = asObject(raw.incidents);
  const attendance = asObject(raw.attendance);
  const away = asObject(raw.away_time);
  const identity = asObject(raw.identity);
  const personId = String(
    raw.person_id || raw.employee_id || raw.track_id || ""
  ).trim();
  const name = String(
    raw.display_name || raw.name || identity.display_name || personId || "Staff"
  ).trim();
  const incidentCount = asNumber(
    incidents.total ?? raw.incident_count ?? raw.violation_count,
    0
  );
  const behaviorScore = asNumber(
    scores.behavior_score ?? raw.behavior_score ?? raw.score,
    0
  );
  const photoUrl =
    hasPhoto && personId
      ? publicMediaUrl({ kind: "enrolled", person_id: personId })
      : null;
  return {
    person_id: personId,
    employee_id: personId,
    name,
    display_name: name,
    photo_url: photoUrl,
    avatar: photoUrl,
    has_photo: Boolean(photoUrl),
    behavior_score: behaviorScore,
    score: behaviorScore,
    productivity_score: asNumber(
      scores.productivity_score ?? raw.productivity_score,
      0
    ),
    working_ratio: asNumber(scores.working_ratio ?? raw.working_ratio, 0),
    working_hours: asNumber(scores.working_hours ?? raw.working_hours, 0),
    incident_count: incidentCount,
    violation_count: incidentCount,
    event_count: incidentCount,
    incidents: {
      fight: asNumber(incidents.fight, 0),
      smoking: asNumber(incidents.smoking, 0),
      phone: asNumber(incidents.phone, 0),
      away: asNumber(incidents.away, 0),
      total: incidentCount,
    },
    attendance_rate: asNumber(
      attendance.rate ?? attendance.attendance_rate ?? raw.attendance_rate,
      behaviorScore
    ),
    attendance_count: asNumber(
      attendance.count ?? attendance.days_present ?? raw.attendance_count,
      0
    ),
    away_minutes: asNumber(away.minutes ?? away.total_minutes, 0),
    last_seen: identity.last_seen_at || raw.last_seen_at || raw.updated_at || null,
    last_camera_id: identity.last_camera_id || raw.last_camera_id || null,
    department: raw.department || raw.org_name || "Garage",
    status: raw.active === false ? "inactive" : "active",
    source: raw.source || "mongo",
  };
}

async function employeesFromLiveData(token) {
  const [profiles, identities] = await Promise.all([
    findScopedDocs("employee_profiles", token, {
      sort: { display_name: 1 },
      limit: 500,
    }),
    findScopedDocs("person_identities", token, {
      sort: { display_name: 1 },
      limit: 500,
    }),
  ]);

  const byId = new Map();
  for (const identity of identities) {
    const id = personKey(identity);
    if (!id) continue;
    byId.set(id, {
      ...stripHeavyFields(identity),
      person_id: id,
      has_enrolled_photo: Boolean(jpegBuffer(identity.enrolled_photo_jpeg)),
      identity: stripHeavyFields(identity),
    });
  }
  for (const profile of profiles) {
    const id = personKey(profile);
    if (!id) continue;
    const prev = byId.get(id) || {};
    byId.set(id, {
      ...prev,
      ...stripHeavyFields(profile),
      person_id: id,
      has_enrolled_photo:
        Boolean(prev.has_enrolled_photo) ||
        Boolean(jpegBuffer(profile.enrolled_photo_jpeg)),
      identity: {
        ...asObject(prev.identity),
        ...asObject(profile.identity),
      },
    });
  }

  if (byId.size) {
    return [...byId.values()].map(publicEmployee).sort(
      (a, b) => (b.behavior_score || 0) - (a.behavior_score || 0)
    );
  }

  const violations = await findScopedDocs("violations", token, {
    sort: { timestamp: -1 },
    limit: 500,
  });
  const fromViolations = new Map();
  for (const row of violations) {
    const person = personFromViolation(row);
    if (!person) continue;
    const prev = fromViolations.get(person.person_id);
    const incidentCount = (prev?.incident_count || 0) + 1;
    const type = String(row.event_type || row.type || "").toLowerCase();
    fromViolations.set(person.person_id, {
      person_id: person.person_id,
      display_name: person.name,
      name: person.name,
      incident_count: incidentCount,
      behavior_score: scoreFromIncidents(type, incidentCount),
    });
  }
  return [...fromViolations.values()].map(publicEmployee).sort(
    (a, b) => (b.behavior_score || 0) - (a.behavior_score || 0)
  );
}

function eventFromRow(row, source) {
  return {
    event_type: row.event_type || row.type || "event",
    type: row.event_type || row.type || "event",
    timestamp: row.timestamp || row.created_at || row.date || null,
    person_id: row.person_id || row.employee_id || null,
    person_name:
      row.display_name || row.person_name || row.employee_name || row.person_id,
    camera_id: row.camera_id || null,
    camera_name: row.camera_name || row.camera_id || null,
    confidence: row.confidence ?? null,
    status: row.status || null,
    source,
  };
}

async function employeeDetailFromLiveData(token, personId) {
  const extra = {
    $or: [
      { person_id: personId },
      { employee_id: personId },
      { track_id: personId },
      { display_name: personId },
    ],
  };
  const [profile] = await findScopedDocs("employee_profiles", token, {
    extra,
    limit: 1,
  });
  const [identity] = await findScopedDocs("person_identities", token, {
    extra,
    limit: 1,
  });
  if (!profile && !identity) return null;

  const merged = {
    ...(identity || {}),
    ...(profile || {}),
    has_enrolled_photo: Boolean(jpegBuffer(identity?.enrolled_photo_jpeg)),
    identity: stripHeavyFields({
      ...asObject(identity),
      ...asObject(profile?.identity),
    }),
  };
  const base = publicEmployee(merged);

  const snapshots = await findScopedDocs("behavior_snapshots", token, {
    extra: {
      $or: [
        { person_id: personId },
        { employee_id: personId },
        { track_id: personId },
        { person_ids: personId },
        { "persons.person_id": personId },
        { display_name: base.name },
      ],
    },
    sort: { timestamp: -1 },
    limit: 12,
  });
  let snapshotRows = snapshots;
  if (!snapshotRows.length) {
    const recentSnaps = await findScopedDocs("behavior_snapshots", token, {
      sort: { timestamp: -1 },
      limit: 40,
    });
    snapshotRows = recentSnaps.filter((row) => {
      const id = String(
        row.person_id || row.employee_id || row.track_id || ""
      );
      return id === personId || id === base.name;
    });
  }

  const history = await findScopedDocs("daily_analytics", token, {
    sort: { date: -1 },
    limit: 14,
  });
  const chart = [...history].reverse().map((day) => {
    const top = (Array.isArray(day.top_employees) ? day.top_employees : []).find(
      (row) =>
        String(row.person_id || "") === personId ||
        String(row.display_name || row.name || "") === base.name
    );
    return {
      date: day.date,
      behavior_score: asNumber(
        top?.behavior_score ?? top?.score ?? base.behavior_score,
        base.behavior_score
      ),
    };
  });

  const recent = [];
  for (const day of history.slice(0, 3)) {
    for (const row of Array.isArray(day.recent_behaviors)
      ? day.recent_behaviors
      : []) {
      const id = String(row.person_id || row.display_name || "");
      if (id !== personId && id !== base.name) continue;
      recent.push(eventFromRow({ ...row, date: day.date }, "daily_analytics"));
    }
  }

  const peers = (await employeesFromLiveData(token)).map((row) => ({
    person_id: row.person_id,
    name: row.name,
    score: row.behavior_score,
  }));

  return {
    ...base,
    snapshots: snapshotRows.map(publicBehaviorSnapshot).filter(Boolean),
    recent_events: recent.slice(0, 20),
    chart,
    peers,
  };
}

async function eventsFromLiveData(token, limit = 200) {
  const violations = await findScopedDocs("violations", token, {
    sort: { timestamp: -1 },
    limit,
  });
  if (violations.length) return violations.map(withSnapshotUrl);

  const [today] = await findScopedDocs("daily_analytics", token, {
    sort: { date: -1 },
    limit: 1,
  });
  const recent = Array.isArray(today?.recent_behaviors)
    ? today.recent_behaviors
    : [];
  if (recent.length) {
    return recent.slice(0, limit).map((row) =>
      eventFromRow({ ...row, date: today.date }, "daily_analytics")
    );
  }

  const samples = await findScopedDocs("behavior_samples", token, {
    sort: { timestamp: -1 },
    limit: Math.min(limit, 80),
  });
  const events = [];
  for (const sample of samples) {
    const alerts = Array.isArray(sample.alerts) ? sample.alerts : [];
    const persons = Array.isArray(sample.persons) ? sample.persons : [];
    if (!alerts.length) continue;
    for (const alert of alerts) {
      const person = persons[0] || {};
      events.push(
        eventFromRow(
          {
            event_type: alert.event_type || alert.type || "alert",
            timestamp: sample.timestamp,
            camera_id: sample.camera_id,
            camera_name: sample.camera_name,
            person_id: alert.person_id || person.person_id,
            display_name: alert.display_name || person.display_name,
            confidence: alert.confidence,
          },
          "behavior_samples"
        )
      );
      if (events.length >= limit) return events;
    }
  }
  return events;
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

    const violations = rows.length
      ? rows.map(withSnapshotUrl)
      : await eventsFromLiveData(token, limit);

    return res.status(200).json({
      ok: true,
      violations,
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

    const liveRows = await findScopedDocs("behavior_snapshots", token, {
      sort: { timestamp: -1 },
      limit,
    });
    const live = liveRows.map(publicBehaviorSnapshot).filter(Boolean);
    if (live.length) {
      return res.status(200).json({
        ok: true,
        snapshots: live.slice(0, limit),
        organization: toPublicOrg(org),
      });
    }

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
      const item = publicBehaviorSnapshot(row);
      const key = item?.image_url || item?.path;
      if (!item || !key || seen.has(key)) continue;
      seen.add(key);
      snapshots.push(item);
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

/** GET /mobile/media?kind=enrolled&person_id=person_00001 */
const proxyMedia = async (req, res) => {
  try {
    const auth = await requireValidOrg(req, res);
    if (!auth) return;
    const { token } = auth;
    const kind = String(req.query.kind || "").trim().toLowerCase();

    if (kind === "enrolled") {
      const personId = String(req.query.person_id || "").trim();
      if (!personId) {
        return statusCodeTemplate(res, 400, "Missing person_id");
      }
      const extra = {
        $or: [
          { person_id: personId },
          { employee_id: personId },
          { track_id: personId },
        ],
      };
      const [identity] = await findScopedDocs("person_identities", token, {
        extra,
        limit: 1,
      });
      const buf =
        jpegBuffer(identity?.enrolled_photo_jpeg) ||
        jpegBuffer(
          (
            await findScopedDocs("employee_profiles", token, {
              extra,
              limit: 1,
            })
          )[0]?.enrolled_photo_jpeg
        );
      if (!buf) {
        return statusCodeTemplate(res, 404, "Enrolled photo not found.");
      }
      return sendJpeg(res, buf);
    }

    if (kind === "snapshot") {
      const id = String(req.query.id || "").trim();
      if (!id) {
        return statusCodeTemplate(res, 400, "Missing snapshot id");
      }
      const extra = mongoose.Types.ObjectId.isValid(id)
        ? {
            $or: [{ _id: new mongoose.Types.ObjectId(id) }, { _id: id }],
          }
        : {
            $or: [{ snapshot_id: id }, { filename: id }],
          };
      const [row] = await findScopedDocs("behavior_snapshots", token, {
        extra,
        limit: 1,
      });
      const buf = snapshotJpegFromDoc(row);
      if (buf) return sendJpeg(res, buf);
      if (row) {
        const rel = snapshotRelFromDoc(row);
        if (rel && /^https?:\/\//i.test(rel)) {
          return res.redirect(rel);
        }
      }
      return statusCodeTemplate(res, 404, "Snapshot image is not available.");
    }

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
    const snapOwned = owned.length
      ? owned
      : await findScopedDocs("behavior_snapshots", token, {
          extra: {
            $or: [
              { local_snapshot: rel },
              { local_snapshot: { $regex: `${escaped}$` } },
            ],
          },
          limit: 1,
        });
    if (!snapOwned.length) {
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

    const persons = await employeesFromLiveData(token);

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
      if (
        ai.status >= 200 &&
        ai.status < 300 &&
        hasUsefulAiPayload(ai.body?.dashboard || ai.body?.today || ai.body)
      ) {
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
      if (
        ai.status >= 200 &&
        ai.status < 300 &&
        hasUsefulAiPayload(ai.body?.today || ai.body?.dashboard)
      ) {
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
    if (rows[0] && Object.keys(rows[0]).length) {
      return res.status(200).json({
        ok: true,
        today: rows[0],
        organization: toPublicOrg(org),
      });
    }

    const employees = await employeesFromLiveData(token);
    const violations = await findScopedDocs("violations", token, {
      sort: { timestamp: -1 },
      limit: 200,
    });
    const byType = {};
    for (const row of violations) {
      const type = String(row.event_type || row.type || "other").toLowerCase();
      byType[type] = (byType[type] || 0) + 1;
    }

    return res.status(200).json({
      ok: true,
      today: {
        date: new Date().toISOString().slice(0, 10),
        org_name: org.name,
        top_employees: employees.slice(0, 10),
        behavior_score: employees[0]?.behavior_score || 0,
        totals: {
          violation_total: violations.length,
          ...byType,
        },
        recent_behaviors: violations.slice(0, 10),
      },
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

    const fromMongo = await employeesFromLiveData(token);
    return res.status(200).json({
      ok: true,
      employees: fromMongo,
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

    const employee = await employeeDetailFromLiveData(token, personId);
    if (!employee) {
      return statusCodeTemplate(
        res,
        404,
        "Employee not found for this organization."
      );
    }

    return res.status(200).json({
      ok: true,
      employee,
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
