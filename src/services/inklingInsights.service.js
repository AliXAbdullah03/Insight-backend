const OpenAI = require("openai");
const { findScopedDocs, scopedCollection } = require("./org.service");

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function nvidiaConfig() {
  return {
    apiKey: String(process.env.NVIDIA_API_KEY || "").trim(),
    baseUrl: String(
      process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1"
    ).replace(/\/$/, ""),
    model: String(process.env.NVIDIA_MODEL || "z-ai/glm-5.2").trim(),
  };
}

function eventType(row) {
  return String(row?.event_type || row?.type || "").toLowerCase();
}

function parseTime(raw) {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function buildOrgSnapshot(token, org) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [violations, cameras, todayRows, employees, identities] =
    await Promise.all([
      findScopedDocs("violations", token, {
        sort: { timestamp: -1 },
        limit: 500,
      }),
      findScopedDocs("camera_status", token, {
        sort: { last_seen_at: -1 },
        limit: 50,
      }),
      findScopedDocs("daily_analytics", token, {
        sort: { date: -1 },
        limit: 7,
      }),
      findScopedDocs("employee_profiles", token, {
        sort: { name: 1 },
        limit: 200,
      }),
      findScopedDocs("person_identities", token, {
        sort: { name: 1 },
        limit: 200,
      }),
    ]);

  const staff = employees.length ? employees : identities;
  const today = todayRows[0] || {};
  const byType = {};
  const awayByWeekday = {
    Sunday: 0,
    Monday: 0,
    Tuesday: 0,
    Wednesday: 0,
    Thursday: 0,
    Friday: 0,
    Saturday: 0,
  };
  let last24h = 0;
  let last7d = 0;

  for (const row of violations) {
    const type = eventType(row) || "other";
    byType[type] = (byType[type] || 0) + 1;
    const ts = parseTime(row.timestamp || row.created_at);
    if (ts && ts >= since) last24h += 1;
    if (ts && ts >= weekAgo) {
      last7d += 1;
      if (type === "away") awayByWeekday[WEEKDAYS[ts.getDay()]] += 1;
    }
  }

  const peakAwayDay = Object.entries(awayByWeekday).sort(
    (a, b) => b[1] - a[1]
  )[0];

  const workingCams = cameras.filter((c) => {
    const err = c.error == null ? "" : String(c.error);
    return !err || err === "null";
  }).length;

  const totals = today.totals && typeof today.totals === "object" ? today.totals : {};
  const behavior =
    today.behavior_score ??
    org?.behavior_score ??
    totals.behavior_score ??
    0;
  const productivity =
    cameras.length === 0 ? 0 : Math.round((workingCams / cameras.length) * 100);

  return {
    organization: org?.name || org?.org_name || "Organization",
    staff_count: staff.length,
    cameras_total: cameras.length,
    cameras_online: workingCams,
    violations_total: violations.length,
    violations_last_24h: last24h || violations.length,
    violations_last_7d: last7d || violations.length,
    by_type: byType,
    away_by_weekday: awayByWeekday,
    peak_away_day: peakAwayDay ? { day: peakAwayDay[0], count: peakAwayDay[1] } : null,
    behavior_score: Number(behavior) || 0,
    productivity_score: Number(productivity) || 0,
    daily_analytics_date: today.date || today.created_at || null,
  };
}

function fallbackInsights(snapshot) {
  const org = snapshot.organization;
  const peak = snapshot.peak_away_day;
  const awayTotal = Object.values(snapshot.away_by_weekday || {}).reduce(
    (sum, n) => sum + n,
    0
  );
  const attendanceMessage =
    peak && peak.count > 0
      ? `Away time is highest on ${peak.day}s (${peak.count} events this week). Review staffing for that day.`
      : awayTotal > 0
        ? `${awayTotal} away events were recorded this week. Watch coverage during peak hours.`
        : "No strong absenteeism pattern this week. Attendance looks stable.";

  const fights = snapshot.by_type?.fight || 0;
  const smoking = snapshot.by_type?.smoking || 0;
  const phone = snapshot.by_type?.phone || 0;
  const score = snapshot.behavior_score > 10
    ? snapshot.behavior_score
    : snapshot.behavior_score * 10;

  return [
    {
      type: "attendance",
      title: "Attendance Pattern",
      heading: `${org} — attendance`,
      message: attendanceMessage,
    },
    {
      type: "performance",
      title: "Performance Insight",
      heading: `${org} — today's overview`,
      message: `Behavior score is ${Math.round(score)}/100 with productivity at ${snapshot.productivity_score}/100. ${snapshot.staff_count} staff enrolled; ${snapshot.violations_last_24h} incidents in the last 24 hours (${fights} fight, ${smoking} smoking, ${phone} phone).`,
    },
  ];
}

function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) {}
  }
  return null;
}

function normalizeInsights(parsed, snapshot) {
  const fallback = fallbackInsights(snapshot);
  const rows = Array.isArray(parsed?.insights)
    ? parsed.insights
    : Array.isArray(parsed)
      ? parsed
      : [];
  const mapped = rows
    .map((row, index) => {
      if (!row || typeof row !== "object") return null;
      const type =
        String(row.type || "").toLowerCase() ||
        (index === 0 ? "attendance" : "performance");
      const message = String(
        row.message || row.text || row.summary || row.content || ""
      ).trim();
      if (!message) return null;
      return {
        type,
        title:
          row.title ||
          (type === "attendance" ? "Attendance Pattern" : "Performance Insight"),
        heading: row.heading || row.subtitle || fallback[index]?.heading || "",
        message,
      };
    })
    .filter(Boolean);

  if (mapped.length >= 2) return mapped.slice(0, 4);
  if (mapped.length === 1) {
    return [mapped[0], fallback[1]];
  }
  return fallback;
}

async function callNvidiaGlm(snapshot) {
  const { apiKey, baseUrl, model } = nvidiaConfig();
  if (!apiKey) {
    console.error("NVIDIA insights skipped: NVIDIA_API_KEY is missing.");
    return null;
  }

  const timeoutMs = Number(process.env.NVIDIA_TIMEOUT_MS || 20000);
  const maxTokens = Number(process.env.NVIDIA_MAX_TOKENS || 2048);
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout: timeoutMs,
  });
  const started = Date.now();
  try {
    const stream = await client.chat.completions.create({
      model,
      temperature: 1,
      top_p: 1,
      max_tokens: maxTokens,
      seed: 42,
      stream: true,
      messages: [
        {
          role: "user",
          content: `You are writing AI Insights cards for a garage operations app. Use ONLY these MongoDB stats. Do not invent cameras, people, or numbers.\n${JSON.stringify(snapshot)}\n\nReturn JSON only, no markdown:\n{"insights":[{"type":"attendance","title":"Attendance Pattern","heading":"${snapshot.organization} — attendance","message":"<2 short sentences about away/attendance using the weekday counts>"},{"type":"performance","title":"Performance Insight","heading":"${snapshot.organization} — today's overview","message":"<2 short sentences using behavior_score, productivity_score, staff_count, violations_last_24h and by_type>"}]}`,
        },
      ],
    });

    let content = "";
    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta?.content || "";
    }

    const elapsed = Date.now() - started;
    console.log(`NVIDIA ${model} insights ready in ${elapsed}ms`);
    return extractJson(content);
  } catch (error) {
    const elapsed = Date.now() - started;
    console.error(
      `NVIDIA insights skipped after ${elapsed}ms:`,
      error.message
    );
    return null;
  }
}

async function recentCachedInsights(token) {
  const rows = await findScopedDocs("insights", token, {
    extra: { source: "nvidia-glm" },
    sort: { created_at: -1 },
    limit: 6,
  });
  if (!rows.length) return null;
  const newest = rows[0].created_at || rows[0].timestamp;
  const ts = parseTime(newest);
  if (!ts || Date.now() - ts.getTime() > 15 * 60 * 1000) return null;
  const mapped = rows
    .map((row) => ({
      type: row.type || "performance",
      title: row.title || "Insight",
      heading: row.heading || "",
      message: row.message || row.text || row.summary || "",
    }))
    .filter((row) => row.message);
  return mapped.length ? mapped : null;
}

async function saveInsights(token, org, insights) {
  try {
    const col = scopedCollection("insights");
    const now = new Date();
    await col.insertMany(
      insights.map((insight) => ({
        org_token: token,
        org_id: org?.org_id || null,
        org_name: org?.name || null,
        source: "nvidia-glm",
        type: insight.type,
        title: insight.title,
        heading: insight.heading,
        message: insight.message,
        created_at: now,
      }))
    );
  } catch (error) {
    console.error("Failed to cache insights:", error.message);
  }
}

async function generateOrgInsights(token, org) {
  const cached = await recentCachedInsights(token);
  if (cached) return { insights: cached, cached: true };

  const snapshot = await buildOrgSnapshot(token, org);
  const parsed = await callNvidiaGlm(snapshot);
  const insights = normalizeInsights(parsed, snapshot);
  await saveInsights(token, org, insights);
  return { insights, cached: false, snapshot };
}

module.exports = {
  generateOrgInsights,
  buildOrgSnapshot,
};
