/**
 * Server-side proxy to the garage AI Cloudflare host.
 * Flutter web (Chrome) cannot call the AI host directly due to CORS;
 * the Insight backend can.
 */
function aiBackendBase() {
  const raw =
    process.env.AI_BACKEND_URL ||
    process.env.AI_BACKEND_HOST ||
    "https://quiz-change-principles-primarily.trycloudflare.com";
  return String(raw).replace(/\/$/, "");
}

async function aiMobileFetch(pathWithQuery, token) {
  const url = `${aiBackendBase()}${pathWithQuery}`;
  const timeoutMs = Number(process.env.AI_PROXY_TIMEOUT_MS || 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Token": token,
        Accept: "application/json",
        "User-Agent": "InsightBackend/1.0",
      },
      signal: controller.signal,
    });

    let body = null;
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      body = { message: text || "Invalid AI response" };
    }

    return { status: response.status, body };
  } catch (error) {
    console.error("Garage AI proxy idle:", error?.message || error);
    return {
      status: 0,
      body: { ok: false, idle: true, message: "AI is idle" },
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAiOrg(body) {
  if (!body || typeof body !== "object") return null;
  if (body.organization && typeof body.organization === "object") {
    return body.organization;
  }
  if (body.org && typeof body.org === "object") return body.org;
  if (body.org_id || body.name) return body;
  return null;
}

async function fetchAiOrganization(token) {
  const { status, body } = await aiMobileFetch("/mobile/me", token);
  const organization = normalizeAiOrg(body);
  if (status >= 200 && status < 300 && organization) {
    return { ok: true, status, organization, body };
  }
  return { ok: false, status, body };
}

async function fetchAiViolations(token, limit = 50) {
  return aiMobileFetch(`/mobile/violations?limit=${limit}`, token);
}

async function fetchAiCameraStatus(token) {
  return aiMobileFetch("/mobile/status", token);
}

async function fetchAiPersons(token) {
  return aiMobileFetch("/mobile/persons", token);
}

async function fetchAiDashboard(token) {
  return aiMobileFetch("/mobile/analytics/dashboard", token);
}

async function fetchAiToday(token) {
  return aiMobileFetch("/mobile/analytics/today", token);
}

async function fetchAiEmployees(token) {
  return aiMobileFetch("/mobile/analytics/employees", token);
}

async function fetchAiEmployee(token, personId) {
  return aiMobileFetch(
    `/mobile/analytics/employees/${encodeURIComponent(personId)}`,
    token
  );
}

async function fetchAiInsights(token) {
  return aiMobileFetch("/mobile/analytics/insights", token);
}

/** Fetch a garage snapshot/media file as bytes. Returns null if not an image. */
async function fetchAiMedia(relPath, token) {
  const rel = String(relPath || "").replace(/^\/+/, "");
  if (!rel) return null;
  const encoded = encodeURIComponent(rel);
  const timeoutMs = Math.min(
    Number(process.env.AI_PROXY_TIMEOUT_MS || 60000),
    12000
  );
  const candidates = [
    `${aiBackendBase()}/${rel}`,
    `${aiBackendBase()}/snapshots/${rel.replace(/^snapshots\//, "")}`,
    `${aiBackendBase()}/static/${rel}`,
    `${aiBackendBase()}/media/${rel}`,
    `${aiBackendBase()}/mobile/media?path=${encoded}`,
  ];

  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Org-Token": token,
          Accept: "image/*,application/octet-stream",
          "User-Agent": "InsightBackend/1.0",
        },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (
        contentType &&
        !contentType.startsWith("image/") &&
        !contentType.includes("octet-stream")
      ) {
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) continue;
      return {
        buffer,
        contentType: contentType.startsWith("image/")
          ? contentType
          : "image/jpeg",
      };
    } catch (_) {
      // try next candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

module.exports = {
  aiBackendBase,
  fetchAiOrganization,
  fetchAiViolations,
  fetchAiCameraStatus,
  fetchAiPersons,
  fetchAiDashboard,
  fetchAiToday,
  fetchAiEmployees,
  fetchAiEmployee,
  fetchAiInsights,
  fetchAiMedia,
};
