/**
 * IndicatorCache  (Phase 1 — Shared Indicator Cache)
 * --------------------------------------------------
 * Memoization layer over the existing per-scanner EMA/ATR/RSI helpers.
 *
 * Cache key: `${symbol}|${indicator}|${period}|${lastBarDate}`
 *  - When a scanner asks for EMA(50) on RELIANCE while the last bar is
 *    still 2026-01-15T09:30, all subsequent calls in the same cycle (or
 *    across cycles until a new bar arrives) return the cached value.
 *  - Once a new bar lands the key changes -> fresh recomputation.
 *
 * This is the “Shared Indicator Cache” item from Phase 1 and gives the
 * largest CPU win we can deliver *without* rewriting hullScanner /
 * momentumTracker / refinedIndexScanner internals.
 *
 * Usage:
 *   const ic = require("./indicatorCache");
 *   const ema = ic.memo("RELIANCE", "EMA", 50, candles, () => emaSeries(closes, 50));
 *
 * The compute closure is invoked at most once per (symbol, indicator,
 * period, lastBarDate). Result type is opaque (array, number, object).
 */

const _cache = new Map(); // key -> { value, ts }
const MAX_ENTRIES = 20000;

function _key(symbol, indicator, period, lastBarDate) {
  return `${symbol}|${indicator}|${period}|${lastBarDate || "_"}`;
}

function memo(symbol, indicator, period, candles, computeFn) {
  if (!candles || candles.length === 0) return computeFn();
  const lastBarDate = candles[candles.length - 1].date || candles.length;
  const key = _key(symbol, indicator, period, lastBarDate);
  const hit = _cache.get(key);
  if (hit) return hit.value;

  const value = computeFn();
  _cache.set(key, { value, ts: Date.now() });

  // Simple FIFO eviction to keep memory bounded.
  if (_cache.size > MAX_ENTRIES) {
    const first = _cache.keys().next().value;
    _cache.delete(first);
  }
  return value;
}

function invalidateSymbol(symbol) {
  if (!symbol) return 0;
  const prefix = `${symbol}|`;
  let removed = 0;
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) { _cache.delete(k); removed += 1; }
  }
  return removed;
}

function stats() { return { entries: _cache.size, maxEntries: MAX_ENTRIES }; }

function clear() { _cache.clear(); }

module.exports = { memo, invalidateSymbol, stats, clear };
