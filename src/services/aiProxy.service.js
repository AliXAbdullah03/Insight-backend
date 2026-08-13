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
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Org-Token": token,
      Accept: "application/json",
    },
  });

  let body = null;
  const text = await response.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_) {
    body = { message: text || "Invalid AI response" };
  }

  return { status: response.status, body };
}

async function fetchAiOrganization(token) {
  const { status, body } = await aiMobileFetch("/mobile/me", token);
  if (status >= 200 && status < 300 && body?.organization) {
    return { ok: true, status, organization: body.organization, body };
  }
  return { ok: false, status, body };
}

async function fetchAiViolations(token, limit = 50) {
  return aiMobileFetch(`/mobile/violations?limit=${limit}`, token);
}

async function fetchAiCameraStatus(token) {
  return aiMobileFetch("/mobile/status", token);
}

module.exports = {
  aiBackendBase,
  fetchAiOrganization,
  fetchAiViolations,
  fetchAiCameraStatus,
};
