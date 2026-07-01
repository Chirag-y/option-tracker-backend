const express = require("express");
const router = express.Router();
const User = require("../models/User");
const WebhookEvent = require("../models/WebhookEvent");
const { sendPushToUsers } = require("../utils/onesignal");
const { buildWebhookNotificationText, createNotification } = require("../utils/notifications");

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

const notifyAllUsers = async ({ payload, source, eventType, eventId, notificationId }) => {
  const users = await User.find({
    isVerified: true,
    isTeamApproved: { $ne: false },
    intradayStockAlertsEnabled: { $ne: false }
  }).select("_id");
  const recipientIds = users.map((user) => String(user._id));
  const { title, message } = buildWebhookNotificationText(payload, source);

  const result = await sendPushToUsers({
    recipientIds,
    name: "webhook-alert",
    headings: { en: title },
    contents: { en: message },
    data: {
      // Canonical mobile-side type — matches the in-app feed value so the RN
      // client's shouldSuppress() and dedup logic can key off a stable string.
      type: "WEBHOOK_ALERT",
      // The persisted Notification _id — used by the mobile client as the
      // dedup key so the OS can't re-display already-shown alerts when the
      // app foregrounds.
      notificationId: notificationId || null,
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

    try {
      const webhookText = buildWebhookNotificationText(payload, source);
      const storedNotification = await createNotification({
        type: "WEBHOOK_ALERT",
        scope: "GLOBAL",
        teamCode: null,
        title: webhookText.title,
        message: webhookText.message,
        source,
        eventType,
        payload,
        metadata: webhookText.metadata,
        relatedWebhookEventId: event._id
      });
      // Stash the persisted notification id on the request so the OneSignal
      // payload can include it (mobile dedup keys off this).
      req._storedNotificationId = storedNotification?._id ? String(storedNotification._id) : null;
    } catch (storeErr) {
      console.error("Failed to store webhook notification:", storeErr?.message || storeErr);
    }

    let notification = { attempted: 0, onesignal: null };
    try {
      notification = await notifyAllUsers({
        payload,
        source,
        eventType,
        eventId: event._id,
        notificationId: req._storedNotificationId
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
