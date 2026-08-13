const express = require("express");
const { extractOrgToken } = require("../services/org.service");
const { aiBackendBase } = require("../services/aiProxy.service");
const { statusCodeTemplate } = require("../utils/api.utils");

/**
 * Forward /api/ai/* → {AI_BACKEND_URL}/api/*
 * Fixes Flutter web CORS when Chrome cannot call the Cloudflare AI host.
 */
async function proxyAiApi(req, res) {
  try {
    const token = extractOrgToken(req);
    // req.url is relative to this mount (includes query string).
    const targetUrl = `${aiBackendBase()}/api${req.url}`;

    const headers = {
      Accept: req.headers.accept || "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers["X-Org-Token"] = token;
    }

    const init = {
      method: req.method,
      headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      if (req.body && Object.keys(req.body).length > 0) {
        init.body = JSON.stringify(req.body);
      }
    }

    const upstream = await fetch(targetUrl, init);
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "";

    res.status(upstream.status);
    if (contentType.includes("application/json")) {
      try {
        return res.json(text ? JSON.parse(text) : {});
      } catch (_) {
        return res.type("application/json").send(text);
      }
    }
    if (contentType) res.type(contentType);
    return res.send(text);
  } catch (error) {
    console.error("AI API proxy failed:", error.message);
    return statusCodeTemplate(
      res,
      502,
      `Garage AI proxy failed: ${error.message}`
    );
  }
}

const router = express.Router();
router.use(proxyAiApi);

module.exports = router;
