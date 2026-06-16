const express = require("express");
const router = express.Router();
const User = require("../models/User");
const WebhookEvent = require("../models/WebhookEvent");
const { sendPushToUsers } = require("../utils/onesignal");

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

const splitCsv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const formatChartinkAlert = (payload) => {
  if (!payload.stocks && !payload.scan_name && !payload.alert_name) {
    return null;
  }

  const stocks = splitCsv(payload.stocks);
  const prices = splitCsv(payload.trigger_prices);
  const pairs = stocks.map((stock, index) => {
    const price = prices[index];
    return price ? `${stock} @ ${price}` : stock;
  });

  const title = String(payload.alert_name || payload.scan_name || "Chartink alert").trim();
  const messageParts = [];
  if (pairs.length) {
    messageParts.push(pairs.slice(0, 8).join(", "));
  }
  if (stocks.length > 8) {
    messageParts.push(`+${stocks.length - 8} more`);
  }
  if (payload.triggered_at) {
    messageParts.push(`at ${payload.triggered_at}`);
  }

  return {
    title,
    message: messageParts.join(" ") || "Chartink alert triggered"
  };
};

const getWebhookText = (payload, source) => {
  const chartinkAlert = formatChartinkAlert(payload);
  if (chartinkAlert) {
    return chartinkAlert;
  }

  const title = String(payload.title || payload.heading || `${source} alert`).trim();
  const message = String(
    payload.message ||
    payload.content ||
    payload.alert ||
    payload.text ||
    payload.raw ||
    "New webhook alert received"
  ).trim();

  return {
    title: title || "Webhook alert",
    message: message || "New webhook alert received"
  };
};

const notifyAllUsers = async ({ payload, source, eventType, eventId }) => {
  const users = await User.find({
    isVerified: true,
    isTeamApproved: { $ne: false }
  }).select("_id");
  const recipientIds = users.map((user) => String(user._id));
  const { title, message } = getWebhookText(payload, source);

  const result = await sendPushToUsers({
    recipientIds,
    name: "webhook-alert",
    headings: { en: title },
    contents: { en: message },
    data: {
      type: "webhook_alert",
      webhookEventId: String(eventId),
      source,
      eventType
    }
  });

  return {
    attempted: recipientIds.length,
    onesignal: result
  };
};

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

    let notification = { attempted: 0, onesignal: null };
    try {
      notification = await notifyAllUsers({
        payload,
        source,
        eventType,
        eventId: event._id
      });
    } catch (notifErr) {
      console.error("Webhook notification failed:", notifErr?.response?.data || notifErr?.message || notifErr);
      notification = {
        attempted: 0,
        error: "Failed to send OneSignal notification"
      };
    }

    res.status(202).json({
      message: "Webhook received",
      id: event._id,
      source,
      eventType,
      notification
    });
  } catch (err) {
    console.error("Webhook receive failed:", err?.message || err);
    res.status(500).json({ message: "Failed to receive webhook" });
  }
});

module.exports = router;
