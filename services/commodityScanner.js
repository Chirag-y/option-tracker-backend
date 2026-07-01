/**
 * CommodityScanner  (Phase 3)
 * ---------------------------
 * Lightweight, settings-aware scanner for the MCX universe.
 *
 * For each active commodity contract:
 *   - Compute RSI(14) on the available daily candles via indicatorEngine.
 *   - Compute ATR(14) for SL / breakout sizing.
 *   - Apply per-commodity thresholds from config/commodityScannerSettings.js:
 *       * RSI overbought / oversold gates
 *       * Strength floor before broadcasting
 *       * Breakout % vs N-bar high
 *
 * Designed to be registered with ScannerRegistry so the ScannerManager
 * runs it at the commodity-specific cadence (faster for CRUDEOIL etc).
 *
 * Output: dispatches via AlertManager so dedup / push / persistence
 * pipelines are reused.
 */
const { getActiveCommodityUniverse } = require("./commodityContractManager");
const { getCommoditySettings, baseCommodity } = require("../config/commodityScannerSettings");
const indicatorEngine = require("./indicatorEngine");
const candleCache     = require("./candleCacheManager");
const { getTickCache } = require("./marketDataFeed");
const alertManager    = require("./alertManager");
const indicatorCache  = require("./indicatorCache");

const SCANNER_ID = "commodity-momentum";

function _highOverWindow(candles, n) {
  if (!candles || candles.length === 0) return null;
  const w = candles.slice(-n);
  return Math.max(...w.map(c => c.high));
}

async function run() {
  const universe = await getActiveCommodityUniverse();
  if (!universe || universe.length === 0) return [];

  const ticks = getTickCache() || {};
  const out = [];

  for (const c of universe) {
    const cfg = getCommoditySettings(c.symbol);
    const base = baseCommodity(c.symbol) || c.commodity;

    const tick = ticks[c.symbol] || ticks[base] || {};
    const ltp = Number(tick.ltp ?? tick.price ?? 0);
    if (!ltp) continue;
    if ((tick.volume || 0) < cfg.minVolume) continue;

    const candles = candleCache.getSeries(c.symbol, "DAILY") || [];
    if (candles.length < cfg.atrPeriod + 2) continue;

    // Use the cached RSI/ATR if last bar hasn't changed.
    const rsi = indicatorCache.memo(c.symbol, "RSI", 14, candles, () =>
      indicatorEngine.rsi.seed(c.symbol, "DAILY", 14, candles.map(x => x.close))
    );
    const atr = indicatorCache.memo(c.symbol, "ATR", cfg.atrPeriod, candles, () =>
      indicatorEngine.atr.seed(c.symbol, "DAILY", cfg.atrPeriod, candles)
    );

    const nBarHigh   = _highOverWindow(candles, 20);
    const breakout   = nBarHigh && ltp >= nBarHigh * (1 + cfg.breakoutPct / 100);
    const overbought = rsi != null && rsi >= cfg.rsiOverbought;
    const oversold   = rsi != null && rsi <= cfg.rsiOversold;

    let direction = null;
    if (breakout || oversold) direction = "BULLISH";
    else if (overbought)      direction = "BEARISH";
    if (!direction) continue;

    // Crude strength score derived from RSI distance + ATR-normalised breakout.
    const rsiDistance = direction === "BULLISH"
      ? Math.max(0, (cfg.rsiOversold - (rsi ?? cfg.rsiOversold)) + 30)
      : Math.max(0, ((rsi ?? cfg.rsiOverbought) - cfg.rsiOverbought) + 30);
    const atrNorm = atr ? Math.min(40, Math.abs(ltp - (nBarHigh ?? ltp)) / atr * 20) : 0;
    const strengthScore = Math.min(100, Math.round(40 + rsiDistance + atrNorm));
    if (strengthScore < cfg.strengthFloor) continue;

    const signal = {
      symbol:        c.symbol,
      name:          base,
      price:         ltp,
      change:        Number(tick.changePercent ?? 0),
      direction,
      signalStrength: strengthScore > 75 ? "STRONG" : strengthScore > 60 ? "MEDIUM" : "WEAK",
      strengthScore,
      triggerTime:   new Date().toLocaleTimeString(),
      triggerPrice:  ltp,
      postTriggerChange: 0,
      sector:        "Commodity",
      isFO:          false,
      commodity:     base,
      atr,
      rsi,
      timestamp:     new Date().toLocaleTimeString(),
    };
    out.push(signal);

    // Centralised dispatch — alertManager handles dedup + socket + push.
    alertManager.dispatch({ scannerId: SCANNER_ID, signalInfo: signal });
  }
  return out;
}

/**
 * Register with ScannerRegistry so ScannerManager picks us up.
 * The cadence comes from the *fastest* commodity setting so we don't
 * miss CRUDEOIL moves (slower commodities still run at this rate but
 * skip via the early `continue` on minVolume / candle gates).
 */
function register(registry) {
  const fastest = require("../config/commodityScannerSettings")
    .listCommoditySettings()
    .reduce((min, s) => Math.min(min, s.scanIntervalMs || 60_000), 60_000);
  registry.register({
    id:         SCANNER_ID,
    label:      "Commodity Momentum",
    priority:   3,
    universe:   "commodity",
    intervalMs: fastest,
    run,
  });
}

module.exports = { run, register, SCANNER_ID };
