/**
 * LiveUniverseManager
 * ===================
 * Phase 0 — the single, authoritative owner of WebSocket subscriptions.
 *
 *   Sources merged into the live universe:
 *     1. F&O Universe          (from MongoDB / InstrumentUniverse)
 *     2. Swing Tracker signals (from MongoDB / SwingCandidate, last 3 trading days)
 *     3. Indices               (NIFTY, BANKNIFTY, SENSEX — static)
 *     4. Commodities           (from MongoDB / CommodityContract, daily rollover)
 *
 *   Responsibilities:
 *     - Build & cache the merged live universe (deduplicated by canonical symbol)
 *     - Diff against the currently subscribed set and emit subscribe/unsubscribe
 *     - Daily refresh (08:30 IST)
 *     - Hot refresh API for the rest of the app (`refreshNow()`)
 *
 *   Expected size: ~250–330 symbols (vs 1600+) -> 80–85% fewer ticks.
 *
 *   IMPORTANT: All other modules MUST stop calling subscribeToSymbols() directly.
 *   They should record swing signals via swingCandidateStore and let this manager
 *   reconcile subscriptions.
 */
const { syncFoUniverse, getActiveFoUniverse }            = require("./foUniverseSync");
const { syncCommodityContracts, getActiveCommodityUniverse } = require("./commodityContractManager");
const { getRecentSwingSymbols, purgeOlderThan }          = require("./swingCandidateStore");

const INDICES = [
  { symbol: "Nifty 50",     name: "Nifty 50",     source: "index" },
  { symbol: "Nifty Bank",   name: "Bank Nifty",   source: "index" },
  { symbol: "SENSEX",       name: "Sensex",       source: "index" },
];

let _deps = {
  // injected from server.js / marketDataFeed
  subscribeToSymbols:     null,
  unsubscribeFromSymbols: null,
  symbolToTokenMap:       null,
  onSymbolsRemoved:       null,    // optional callback (e.g. evict candle cache)
};

let currentUniverse  = new Map(); // canonicalSymbol -> { symbol, name, sources:Set, ...meta }
let subscribedSet    = new Set(); // canonical symbols we've asked the feed to subscribe to
let refreshTimer     = null;
let refreshing       = false;
let lastRefreshAt    = null;
let lastSummary      = null;

function canonicalize(symbol) {
  if (!symbol) return symbol;
  // The feed layer accepts both raw indices and equity bare symbols (it appends -EQ internally).
  return symbol.trim();
}

function init({ subscribeToSymbols, unsubscribeFromSymbols, symbolToTokenMap, onSymbolsRemoved }) {
  _deps.subscribeToSymbols     = subscribeToSymbols;
  _deps.unsubscribeFromSymbols = unsubscribeFromSymbols;
  _deps.symbolToTokenMap       = symbolToTokenMap;
  _deps.onSymbolsRemoved       = onSymbolsRemoved || null;
}

/** Build the merged universe Map without touching subscriptions. */
async function buildUniverse() {
  const merged = new Map();
  const addAll = (rows, sourceTag) => {
    for (const row of rows) {
      const key = canonicalize(row.symbol);
      if (!key) continue;
      const existing = merged.get(key);
      if (existing) {
        existing.sources.add(sourceTag);
      } else {
        merged.set(key, {
          symbol: key,
          name:   row.name || key,
          isFO:   !!row.isFO,
          sector: row.sector || "",
          sources: new Set([sourceTag]),
        });
      }
    }
  };

  // 1. F&O
  const fo        = await getActiveFoUniverse();
  // 2. Swing (last 3 trading days)
  const swing     = await getRecentSwingSymbols(3);
  // 3. Commodities
  const commodity = await getActiveCommodityUniverse();
  // 4. Indices (static)

  addAll(INDICES,   "index");
  addAll(fo,        "fo");
  addAll(swing,     "swing");
  addAll(commodity, "commodity");

  return { merged, counts: { fo: fo.length, swing: swing.length, commodity: commodity.length, indices: INDICES.length } };
}

/** Diff currentSet vs targetSet and emit subscribe / unsubscribe calls. */
function reconcileSubscriptions(targetUniverse) {
  if (!_deps.subscribeToSymbols) {
    console.warn("[LiveUniverseManager] subscribe handler not wired — skipping reconcile.");
    return { added: 0, removed: 0 };
  }

  const targetSymbols = new Set(targetUniverse.keys());

  const toAdd    = [...targetSymbols].filter(s => !subscribedSet.has(s));
  const toRemove = [...subscribedSet].filter(s => !targetSymbols.has(s));

  if (toAdd.length > 0) {
    _deps.subscribeToSymbols(toAdd);
  }
  if (toRemove.length > 0 && typeof _deps.unsubscribeFromSymbols === "function") {
    _deps.unsubscribeFromSymbols(toRemove);
  }
  if (toRemove.length > 0 && typeof _deps.onSymbolsRemoved === "function") {
    try { _deps.onSymbolsRemoved(toRemove); }
    catch (e) { console.error("[LiveUniverseManager] onSymbolsRemoved hook failed:", e.message); }
  }

  subscribedSet = targetSymbols;
  return { added: toAdd.length, removed: toRemove.length };
}

async function refreshNow({ skipSync = false } = {}) {
  if (refreshing) return lastSummary;
  refreshing = true;
  try {
    if (!skipSync) {
      // Best-effort syncs — never block reconciliation.
      try { await syncFoUniverse({ symbolToTokenMap: _deps.symbolToTokenMap }); }
      catch (e) { console.error("[LiveUniverseManager] FO sync err:", e.message); }
      try { await syncCommodityContracts({ symbolToTokenMap: _deps.symbolToTokenMap }); }
      catch (e) { console.error("[LiveUniverseManager] Commodity sync err:", e.message); }
      try { await purgeOlderThan(30); } catch (e) { /* non-fatal */ void e; }
    }

    const { merged, counts } = await buildUniverse();
    const diff = reconcileSubscriptions(merged);
    currentUniverse = merged;
    lastRefreshAt   = new Date();

    lastSummary = {
      total:      merged.size,
      counts,
      diff,
      at:         lastRefreshAt,
    };

    console.log(
      `[LiveUniverseManager] Refreshed — total=${merged.size} ` +
      `(fo=${counts.fo}, swing=${counts.swing}, commodity=${counts.commodity}, indices=${counts.indices}) ` +
      `+${diff.added} / -${diff.removed}`
    );
    return lastSummary;
  } finally {
    refreshing = false;
  }
}

/** Schedule daily refresh at 08:30 IST. Re-entrant-safe. */
function scheduleDailyRefresh() {
  if (refreshTimer) return;

  const computeMsUntilNext = () => {
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const target = new Date(istNow);
    target.setUTCHours(3, 0, 0, 0); // 08:30 IST == 03:00 UTC
    if (target <= istNow) target.setUTCDate(target.getUTCDate() + 1);
    return target.getTime() - istNow.getTime();
  };

  const tick = async () => {
    try { await refreshNow(); }
    catch (e) { console.error("[LiveUniverseManager] Daily refresh failed:", e.message); }
    refreshTimer = setTimeout(tick, computeMsUntilNext());
  };

  refreshTimer = setTimeout(tick, computeMsUntilNext());
  console.log(`[LiveUniverseManager] Daily refresh scheduled in ${(computeMsUntilNext()/1000/60).toFixed(1)} min`);
}

function getUniverse() {
  return Array.from(currentUniverse.values());
}

function getSummary() {
  return lastSummary || { total: 0, counts: {}, diff: { added: 0, removed: 0 }, at: null };
}

module.exports = {
  init,
  refreshNow,
  scheduleDailyRefresh,
  getUniverse,
  getSummary,
};
