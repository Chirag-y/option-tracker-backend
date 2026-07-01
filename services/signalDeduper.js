/**
 * SignalDeduper  (Phase 7)
 * ------------------------
 * Sliding-window deduplication for scanner signals.
 * Key:    `${scannerId}|${symbol}|${direction}`
 * Window: configurable (default 15 min); within the window identical signals
 *         are suppressed -> no duplicate push notifications or socket spam.
 *
 * Memory: O(signals_in_window). LRU-evicts on insert when size exceeds cap.
 */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES       = 50000;

const _seen = new Map(); // key -> lastSeenMs

function _key(scannerId, symbol, direction) {
  return `${scannerId || "_"}|${symbol}|${direction || "_"}`;
}

/**
 * Returns true if this signal is FRESH and should be processed.
 * Returns false if a duplicate within `windowMs` was seen.
 */
function shouldDispatch(scannerId, symbol, direction, windowMs = DEFAULT_WINDOW_MS) {
  if (!symbol) return false;
  const key = _key(scannerId, symbol, direction);
  const now = Date.now();
  const last = _seen.get(key);
  if (last && now - last < windowMs) return false;

  _seen.set(key, now);
  if (_seen.size > MAX_ENTRIES) {
    const oldest = _seen.keys().next().value;
    _seen.delete(oldest);
  }
  return true;
}

function reset() { _seen.clear(); }
function size()  { return _seen.size; }

module.exports = { shouldDispatch, reset, size };
