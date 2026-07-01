/**
 * CandleCacheManager  (Phase 1, P0)
 * =================================
 * Bounded in-memory cache for historical candles per (symbol, timeframe).
 * Replaces the unbounded `historicalDailyCandles` / `historicalIntradayCandles`
 * objects in scannerEngine.js that grow forever and cause OOMs.
 *
 *   - Each (symbol, timeframe) is capped at `MAX_CANDLES` (oldest discarded).
 *   - `appendCandle()` accepts a new candle; if its date matches the last cached
 *     candle's date, that candle is updated *in place* (incremental update).
 *   - `getLastCandle()` is O(1).
 *   - `evictSymbols([...])` lets the LiveUniverseManager drop symbols that are
 *     no longer subscribed.
 *
 * The cache keeps **arrays** (not copies) so existing scannerEngine code that
 * does `historicalDailyCandles[symbol]` can be replaced with `getSeries(...)`
 * with zero algorithmic change.
 */
const MAX_CANDLES_DEFAULT = {
  "DAILY":       500,
  "FIVE_MINUTE": 400,   // ~3 trading days of 5-min bars
  "ONE_MINUTE":  390,   // 1 trading day
  "DEFAULT":     500,
};

const _cache = new Map();  // key -> candle[]

function _key(symbol, timeframe) { return `${symbol}|${timeframe}`; }
function _cap(timeframe) {
  return MAX_CANDLES_DEFAULT[timeframe] || MAX_CANDLES_DEFAULT.DEFAULT;
}

function setSeries(symbol, timeframe, candles) {
  const cap = _cap(timeframe);
  const trimmed = candles.length > cap ? candles.slice(candles.length - cap) : [...candles];
  _cache.set(_key(symbol, timeframe), trimmed);
  return trimmed;
}

function getSeries(symbol, timeframe) {
  return _cache.get(_key(symbol, timeframe)) || null;
}

/** Append or replace-last. Returns the underlying array. */
function appendCandle(symbol, timeframe, candle) {
  const key = _key(symbol, timeframe);
  let arr = _cache.get(key);
  if (!arr) { arr = []; _cache.set(key, arr); }

  const last = arr[arr.length - 1];
  if (last && last.date === candle.date) {
    arr[arr.length - 1] = { ...last, ...candle };
  } else {
    arr.push(candle);
    const cap = _cap(timeframe);
    if (arr.length > cap) arr.splice(0, arr.length - cap);
  }
  return arr;
}

function getLastCandle(symbol, timeframe) {
  const arr = _cache.get(_key(symbol, timeframe));
  return arr && arr.length ? arr[arr.length - 1] : null;
}

function evictSymbols(symbols) {
  if (!symbols || symbols.length === 0) return 0;
  const set = new Set(symbols);
  let removed = 0;
  for (const key of _cache.keys()) {
    const sym = key.split("|", 1)[0];
    if (set.has(sym)) { _cache.delete(key); removed += 1; }
  }
  return removed;
}

function stats() {
  let total = 0;
  for (const arr of _cache.values()) total += arr.length;
  return { keys: _cache.size, totalCandles: total };
}

module.exports = {
  setSeries,
  getSeries,
  appendCandle,
  getLastCandle,
  evictSymbols,
  stats,
};
