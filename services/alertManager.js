/**
 * AlertManager  (Phase 7)
 * -----------------------
 * Central dispatcher for every NEW signal alert.
 *
 *   scanner code -> alertManager.dispatch({ scannerId, signalInfo })
 *                        -> signalDeduper (skip duplicates)
 *                        -> broadcastNewSignal (socket.io)
 *                        -> push notifications (OneSignal)
 *                        -> persistence (SwingCandidate for swing-tracker)
 *
 * Centralising this gives us:
 *   - Single place to add new sinks (Slack, email, webhook, etc.)
 *   - Consistent rate limiting (via signalDeduper)
 *   - Easier observability (counters below)
 */
const signalDeduper          = require("./signalDeduper");
const { broadcastNewSignal } = require("./socketServer");
const { sendPushToUsers }    = require("../utils/onesignal");
const { recordSwingSignal }  = require("./swingCandidateStore");
const User = require("../models/User");

const _counters = {
  total: 0,
  deduped: 0,
  dispatched: 0,
  byScanner: {},
};

function _bump(scannerId, field) {
  _counters[field] += 1;
  _counters.byScanner[scannerId] ||= { total: 0, deduped: 0, dispatched: 0 };
  _counters.byScanner[scannerId][field] += 1;
}

function _scannerLabel(scannerId) {
  return scannerId
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function _sendPush(scannerId, signal) {
  try {
    // Match the User model: `subscribedScanners: [String]`, `onesignalPlayerIds: [String]`.
    const users = await User.find({ subscribedScanners: scannerId })
      .select("_id onesignalPlayerIds intradayStockAlertsEnabled")
      .lean();
    if (!users || users.length === 0) return;

    const recipientIds = users
      .filter(u => u.intradayStockAlertsEnabled !== false)
      .map(u => u._id.toString());
    if (recipientIds.length === 0) return;

    const label = _scannerLabel(scannerId);
    const price = Number(signal.price ?? 0);
    const change = Number(signal.change ?? 0);

    await sendPushToUsers({
      recipientIds,
      name: `Scanner Signal - ${scannerId}`,
      headings: { en: `New Trigger: ${label}` },
      contents: {
        en: `🚨 ${signal.symbol} triggered at ₹${price.toFixed(2)} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)`,
      },
      data: {
        scannerId,
        symbol:    signal.symbol,
        price:     signal.price,
        change:    signal.change,
        direction: signal.direction || null,
      },
    });
  } catch (e) {
    console.error("[AlertManager] push send failed:", e.message);
  }
}

/**
 * Dispatch a new signal through the central pipeline.
 *
 *   scannerId  — required, e.g. "swing-tracker" / "fo-bullish" / "fo-bearish" / "nifty-signals" ...
 *   signalInfo — required, must contain at least { symbol }
 *   persist    — true | false | "auto" (default).  "auto" persists only swing-tracker triggers.
 *
 * Returns { dispatched: boolean, reason?: string }.
 */
async function dispatch({ scannerId, signalInfo, persist = "auto" } = {}) {
  if (!scannerId || !signalInfo || !signalInfo.symbol) {
    return { dispatched: false, reason: "invalid_payload" };
  }
  _bump(scannerId, "total");

  if (!signalDeduper.shouldDispatch(scannerId, signalInfo.symbol, signalInfo.direction)) {
    _bump(scannerId, "deduped");
    return { dispatched: false, reason: "duplicate" };
  }

  // 1. Socket broadcast (sync) — Phase 5 routes this to room `scanner:<id>` + global.
  try { broadcastNewSignal({ scannerId, ...signalInfo }); }
  catch (e) { console.error("[AlertManager] broadcast failed:", e.message); }

  // 2. Push notifications (fire-and-forget).
  _sendPush(scannerId, signalInfo);

  // 3. Persistence — only swing-tracker by default; can be forced via persist=true.
  const shouldPersist =
    persist === true ||
    (persist === "auto" && scannerId === "swing-tracker");
  if (shouldPersist) {
    recordSwingSignal({ ...signalInfo, scannerId }).catch(() => {});
  }

  _bump(scannerId, "dispatched");
  return { dispatched: true };
}

function getStats() { return JSON.parse(JSON.stringify(_counters)); }

function resetStats() {
  _counters.total = 0;
  _counters.deduped = 0;
  _counters.dispatched = 0;
  _counters.byScanner = {};
}

module.exports = { dispatch, getStats, resetStats };
