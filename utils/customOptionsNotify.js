/**
 * Per-user notifications for Custom Options Strategy signals.
 * Only users who enabled alerts AND saved matching call/put strikes receive them.
 * Also forwards live signals to the external webhook (live app) when configured.
 */
const axios = require("axios");
const User = require("../models/User");
const { sendPushToUsers } = require("./onesignal");
const { createNotification } = require("./notifications");
const { shouldDispatch } = require("../services/signalDeduper");

const DEFAULT_EXTERNAL_WEBHOOK_URL = "https://option-tracker.up.railway.app/api/webhooks";

async function forwardCustomOptionsToExternalWebhook(signal) {
  const webhookUrl =
    process.env.EXTERNAL_WEBHOOK_URL ||
    process.env.OPTION_TRACKER_WEBHOOK_URL ||
    DEFAULT_EXTERNAL_WEBHOOK_URL;

  const title = `Custom Options: ${signal.signal} — ${signal.symbol}`;
  const message = `${signal.symbol} ${signal.timeframe} @ ₹${Number(signal.ltp).toFixed(2)} — ${signal.signal} at ${new Date(signal.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;

  const payload = {
    source: "custom-options",
    eventType: "custom-options.signal",
    title,
    message,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    signal: signal.signal,
    ltp: signal.ltp,
    timestamp: signal.timestamp,
    ao: signal.ao,
    macdLine: signal.macdLine,
    macdSignal: signal.macdSignal,
    rsi: signal.rsi,
  };

  const headers = { "Content-Type": "application/json" };
  if (process.env.WEBHOOK_SECRET) {
    headers["x-webhook-secret"] = process.env.WEBHOOK_SECRET;
  }

  try {
    await axios.post(webhookUrl, payload, { headers, timeout: 10_000 });
    console.log(`[CustomOptionsNotify] Forwarded ${signal.signal} for ${signal.symbol} to external webhook`);
  } catch (err) {
    console.error(
      `[CustomOptionsNotify] External webhook forward failed for ${signal.symbol}:`,
      err.response?.data || err.message
    );
  }
}

async function notifyUsersForCustomOptionsSignal(signal) {
  if (!signal?.symbol || !signal?.signal) return { notified: 0 };

  const dedupeKey = `${signal.symbol}|${signal.timeframe}|${signal.signal}`;
  if (!shouldDispatch("custom-options", signal.symbol, dedupeKey, 15 * 60 * 1000)) {
    return { notified: 0, skipped: "duplicate" };
  }

  // Fire-and-forget — keeps live app in sync until backend is deployed there
  forwardCustomOptionsToExternalWebhook(signal).catch(() => {});

  const users = await User.find({
    customOptionsAlertsEnabled: true,
    $or: [
      { customOptionsCallStrike: signal.symbol },
      { customOptionsPutStrike: signal.symbol },
    ],
    isVerified: true,
    isTeamApproved: { $ne: false },
    intradayStockAlertsEnabled: { $ne: false },
  }).select("_id email customOptionsCallStrike customOptionsPutStrike").lean();

  if (!users.length) return { notified: 0 };

  const title = `Custom Options: ${signal.signal} — ${signal.symbol}`;
  const message = `${signal.symbol} ${signal.timeframe} @ ₹${Number(signal.ltp).toFixed(2)} — ${signal.signal} at ${new Date(signal.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;

  let notified = 0;
  for (const user of users) {
    try {
      const notification = await createNotification({
        type: "WEBHOOK_ALERT",
        scope: "USER",
        teamCode: null,
        recipientUserId: user._id,
        title,
        message,
        source: "custom-options",
        eventType: "custom-options.signal",
        payload: {
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          signal: signal.signal,
          ltp: signal.ltp,
          timestamp: signal.timestamp,
        },
        metadata: {
          source: "custom-options",
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          signal: signal.signal,
          ltp: signal.ltp,
          timestamp: signal.timestamp,
          stocks: [{ symbol: signal.symbol, price: signal.ltp }],
        },
      });

      await sendPushToUsers({
        recipientIds: [String(user._id)],
        name: "custom-options-signal",
        headings: { en: title },
        contents: { en: message },
        data: {
          type: "WEBHOOK_ALERT",
          notificationId: notification?._id ? String(notification._id) : null,
          source: "custom-options",
          symbol: signal.symbol,
          signal: signal.signal,
          timeframe: signal.timeframe,
        },
      });
      notified++;
    } catch (err) {
      console.error(`[CustomOptionsNotify] Failed for user ${user._id}:`, err.message);
    }
  }

  if (notified > 0) {
    console.log(`[CustomOptionsNotify] Sent ${notified} alert(s) for ${signal.symbol} ${signal.signal}`);
  }

  return { notified };
}

module.exports = { notifyUsersForCustomOptionsSignal, forwardCustomOptionsToExternalWebhook };
