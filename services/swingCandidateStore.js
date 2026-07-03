/**
 * SwingCandidateStore
 * -------------------
 * Persists Swing Tracker triggers to MongoDB so we can repopulate the live
 * subscription universe with the last N trading days of triggers when the
 * server restarts.
 *
 * Public API:
 *   recordSwingSignal(signal)            -> upsert today's trigger
 *   getRecentSwingSymbols(days = 3)      -> [{ symbol, name, isFO, sector }, ...]
 *   purgeOlderThan(days = 30)            -> housekeeping
 */
const SwingCandidate = require("../models/SwingCandidate");

/** Returns IST midnight for the given JS Date (defaults to "now"). */
function istStartOfDay(date = new Date()) {
  // IST is UTC+05:30 with no DST.
  const ms = date.getTime() + 5.5 * 60 * 60 * 1000;
  const utcMidnight = new Date(ms);
  utcMidnight.setUTCHours(0, 0, 0, 0);
  return new Date(utcMidnight.getTime() - 5.5 * 60 * 60 * 1000);
}

/** Parse trigger date from signal fields — handles ISO dates, YYYY-MM-DD, and rejects time-only strings. */
function resolveTriggerDate(signal) {
  const candidates = [signal.triggerDate, signal.triggerTime, signal.timestamp];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;

    if (typeof raw === "string") {
      // YYYY-MM-DD from swing tracker daily candles
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const d = new Date(`${raw}T00:00:00+05:30`);
        if (!Number.isNaN(d.getTime())) return istStartOfDay(d);
      }
      // Time-only strings like "11:46:30 am" cannot be stored — skip
      if (!raw.includes("-") && !raw.includes("/") && !raw.includes("T")) continue;
    }

    const d = raw instanceof Date ? raw : new Date(raw);
    if (!Number.isNaN(d.getTime())) return istStartOfDay(d);
  }
  return istStartOfDay();
}

/** Walk back `days` *trading* days (skip Sat/Sun). Good enough for live ops; holidays handled by query window. */
function tradingDaysAgo(days) {
  const out = istStartOfDay();
  let remaining = days;
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() - 1);
    const dow = new Date(out.getTime() + 5.5 * 60 * 60 * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return out;
}

async function recordSwingSignal(signal) {
  if (!signal || !signal.symbol) return null;

  const triggerDate = resolveTriggerDate(signal);
  const scannerId   = signal.scannerId || "swing-tracker";

  try {
    return await SwingCandidate.findOneAndUpdate(
      { symbol: signal.symbol, scannerId, triggerDate },
      {
        $set: {
          name:          signal.name || signal.symbol,
          direction:     signal.direction === "BEARISH" ? "BEARISH" : "BULLISH",
          triggerPrice:  Number(signal.triggerPrice ?? signal.price ?? 0),
          strengthScore: Number(signal.strengthScore ?? 0),
          isFO:          !!signal.isFO,
          sector:        signal.sector || "",
          raw:           signal,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error("[SwingCandidateStore] recordSwingSignal failed:", err.message);
    return null;
  }
}

async function getRecentSwingSymbols(days = 3) {
  const from = tradingDaysAgo(days);
  try {
    const rows = await SwingCandidate.aggregate([
      { $match: { triggerDate: { $gte: from } } },
      {
        $group: {
          _id: "$symbol",
          name:   { $last: "$name" },
          isFO:   { $last: "$isFO" },
          sector: { $last: "$sector" },
          lastTriggerDate: { $max: "$triggerDate" },
        },
      },
      { $sort: { lastTriggerDate: -1 } },
    ]);
    return rows.map(r => ({
      symbol: r._id,
      name:   r.name || r._id,
      isFO:   !!r.isFO,
      sector: r.sector || "",
      source: "swing",
      lastTriggerDate: r.lastTriggerDate,
    }));
  } catch (err) {
    console.error("[SwingCandidateStore] getRecentSwingSymbols failed:", err.message);
    return [];
  }
}

async function purgeOlderThan(days = 30) {
  const cutoff = tradingDaysAgo(days);
  try {
    const res = await SwingCandidate.deleteMany({ triggerDate: { $lt: cutoff } });
    if (res.deletedCount) {
      console.log(`[SwingCandidateStore] Purged ${res.deletedCount} swing candidates older than ${days}d`);
    }
  } catch (err) {
    console.error("[SwingCandidateStore] purgeOlderThan failed:", err.message);
  }
}

module.exports = {
  recordSwingSignal,
  getRecentSwingSymbols,
  purgeOlderThan,
  _internal: { istStartOfDay, tradingDaysAgo },
};
