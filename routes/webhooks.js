const express = require("express");
const router = express.Router();
const WebhookEvent = require("../models/WebhookEvent");

const parsePayload = (body) => {
  if (typeof body !== "string") {
    return body || {};
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    return { raw: body };
  }
};

const getSecretFromRequest = (req, payload) =>
  req.get("x-webhook-secret") ||
  req.query.secret ||
  payload?.secret ||
  payload?.webhookSecret;

const sanitizeHeaders = (headers) => ({
  "content-type": headers["content-type"],
  "user-agent": headers["user-agent"],
  "x-forwarded-for": headers["x-forwarded-for"],
  "x-real-ip": headers["x-real-ip"]
});

router.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Webhook endpoint is ready",
    endpoint: "/api/webhooks"
  });
});

router.post("/", express.text({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    const payload = parsePayload(req.body);
    const expectedSecret = process.env.WEBHOOK_SECRET;

    if (expectedSecret && getSecretFromRequest(req, payload) !== expectedSecret) {
      return res.status(401).json({ message: "Invalid webhook secret" });
    }

    const source = String(req.query.source || payload.source || "generic").trim() || "generic";
    const eventType =
      String(req.query.eventType || payload.eventType || payload.type || "webhook.received").trim() ||
      "webhook.received";

    const event = await WebhookEvent.create({
      source,
      eventType,
      payload,
      headers: sanitizeHeaders(req.headers),
      receivedAt: new Date()
    });

    res.status(202).json({
      message: "Webhook received",
      id: event._id,
      source,
      eventType
    });
  } catch (err) {
    console.error("Webhook receive failed:", err?.message || err);
    res.status(500).json({ message: "Failed to receive webhook" });
  }
});

module.exports = router;
