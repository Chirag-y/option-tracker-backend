/**
 * indexSymbolMap.js — Phase 3
 * ---------------------------
 * Central registry mapping frontend / API index aliases to the canonical
 * scrip-master + candle-cache keys used throughout scannerEngine.
 *
 *   resolveIndexAlias("NIFTY")        -> "Nifty 50"
 *   resolveIndexAlias("BANKNIFTY")    -> "Nifty Bank"
 *   resolveIndexAlias("SENSEX")       -> "SENSEX"
 *   resolveIndexAlias("RELIANCE")     -> null   (not an index)
 *
 *   INDEX_KEYS  -> ["Nifty 50", "Nifty Bank", "SENSEX"]
 */
const INDEX_ALIAS_MAP = Object.freeze({
  NIFTY:        "Nifty 50",
  "NIFTY 50":   "Nifty 50",
  NIFTY50:      "Nifty 50",
  BANKNIFTY:    "Nifty Bank",
  "BANK NIFTY": "Nifty Bank",
  "NIFTY BANK": "Nifty Bank",
  SENSEX:       "SENSEX",
  BSESENSEX:    "SENSEX",
});

const INDEX_KEYS = Object.freeze(["Nifty 50", "Nifty Bank", "SENSEX"]);

function resolveIndexAlias(symbol) {
  if (!symbol) return null;
  return INDEX_ALIAS_MAP[String(symbol).toUpperCase()] || null;
}

function isIndexKey(symbol) {
  return INDEX_KEYS.includes(symbol);
}

module.exports = {
  INDEX_ALIAS_MAP,
  INDEX_KEYS,
  resolveIndexAlias,
  isIndexKey,
};
