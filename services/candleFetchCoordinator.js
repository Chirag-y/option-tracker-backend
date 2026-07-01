/**
 * candleFetchCoordinator.js — Phase 2
 * ------------------------------------
 * Coordinates concurrent daily-candle fetches across the engine so we don't
 * make 2-3 parallel SmartAPI calls for the same symbol from the three
 * overlapping fetch paths (startup preload, background F&O preload, EOD scan).
 *
 *   coordinatedFetch(symbol, fetcher) -> Promise<boolean>
 *
 * If a fetch for `symbol` is already in flight we return the same Promise.
 * Otherwise we invoke `fetcher()` (which must return a Promise<boolean>),
 * cache the in-flight promise, and clear it on settle.
 *
 * After a *successful* fetch we also remember the IST date so subsequent
 * callers within the same trading day skip the call entirely.
 */
const { getIstTradingDate } = require("./dailyCandleStore");

const inFlight = new Map();         // symbol -> Promise<boolean>
const lastFetchedIstDate = new Map(); // symbol -> "YYYY-MM-DD"

async function coordinatedFetch(symbol, fetcher) {
  // Already fetched today (in this process) — skip.
  const today = getIstTradingDate();
  if (lastFetchedIstDate.get(symbol) === today) {
    return true;
  }

  const existing = inFlight.get(symbol);
  if (existing) return existing;

  const p = (async () => {
    try {
      const ok = await fetcher();
      if (ok) lastFetchedIstDate.set(symbol, getIstTradingDate());
      return ok;
    } finally {
      inFlight.delete(symbol);
    }
  })();
  inFlight.set(symbol, p);
  return p;
}

/** Clear the in-process today-fetched memo (e.g. for the manual recalculate flow). */
function resetFetchedMemo(symbol) {
  if (symbol) lastFetchedIstDate.delete(symbol);
  else        lastFetchedIstDate.clear();
}

function isInFlight(symbol) {
  return inFlight.has(symbol);
}

module.exports = {
  coordinatedFetch,
  resetFetchedMemo,
  isInFlight,
};
