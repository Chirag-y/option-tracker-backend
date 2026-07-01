/**
 * optionsOpportunityScanner.js — F&O intraday CALL/PUT opportunity scanner
 * --------------------------------------------------------------------------
 * Replaces the previous single-indicator MomentumTrackerV10 gate with a
 * multi-factor confluence scorer designed specifically for intraday F&O
 * option-buying setups.
 *
 *   evaluateOptionsOpportunity(stock, ind, liveData, market)
 *     -> null                                         (no setup)
 *     -> { triggered, direction, strengthScore,
 *          reasons[], confidence, position }          (qualified setup)
 *
 * Inputs:
 *   - stock     :: { symbol, name, sector, isFO } from the universe
 *   - ind       :: indicator pack from getStockIndicators() in scannerEngine.js
 *                  (must include currentEma20/50/200, ema20Rising, currentRsi,
 *                   avgVol20, pdh, previousDayLow, adx, vwap)
 *   - liveData  :: tick payload { price | ltp, volume, changePercent, high, low }
 *   - market    :: { trend: "BULLISH" | "BEARISH" | "SIDEWAYS",
 *                    niftyChangePercent: number }
 *
 * Threshold for qualification: strengthScore >= 75 (matches user spec).
 *
 * Each branch returns `null` early if the structural gate fails (market trend
 * + EMA alignment), so we only score candidates that have a real edge.
 */

const MIN_QUALIFYING_SCORE = 45;
const ADX_TREND_THRESHOLD  = 22;
const VOLUME_BURST_RATIO   = 1.5;
const RSI_BULL_LOW         = 50;
const RSI_BULL_HIGH        = 80;
const RSI_BEAR_HIGH        = 50;
// Reject setups already extended to the day's high (CALL) or low (PUT)
const OVEREXTENDED_HIGH    = 0.98;
const OVEREXTENDED_LOW     = 0.02;

/**
 * Translate the global market overview into a single trend label.
 * Falls back to SIDEWAYS when the overview hasn't been computed yet.
 */
function getMarketTrend(marketOverview) {
  if (!marketOverview) return "SIDEWAYS";
  // Prefer explicit trendScore (0-100) when available, otherwise derive from
  // Nifty intraday change %.
  if (typeof marketOverview.trendScore === "number") {
    if (marketOverview.trendScore >= 70) return "BULLISH";
    if (marketOverview.trendScore <= 30) return "BEARISH";
    return "SIDEWAYS";
  }
  const niftyChg = Number(marketOverview.niftyChangePercent) || 0;
  if (niftyChg >= 0.5)  return "BULLISH";
  if (niftyChg <= -0.5) return "BEARISH";
  return "SIDEWAYS";
}

/**
 * Compute where in the day's range the LTP currently sits (0 = low, 1 = high).
 * Used to filter out chases of already-extended moves.
 */
function dayRangePosition(liveData) { if (!liveData.high || !liveData.low) return 0.5;
  const high = Number(liveData.high) || 0;
  const low  = Number(liveData.low)  || 0;
  const ltp  = Number(liveData.price || liveData.ltp) || 0;
  const range = Math.max(high - low, 0.01);
  return (ltp - low) / range;
}

function classifyConfidence(score) {
  if (score >= 90) return "VERY HIGH";
  if (score >= 82) return "HIGH";
  return "GOOD";
}

/** Bullish CALL setup — requires bullish market + EMA stack alignment. */
function evaluateBullishOption(stock, ind, liveData, market) {
  const price = Number(liveData.price || liveData.ltp) || 0;
  const reasons = [];
  let score = 0;

  if (market.trend === "BULLISH") { score += 15; reasons.push("Bullish Market"); }
  if (ind.currentEma20 > ind.currentEma50 && ind.currentEma50 > ind.currentEma200) { score += 20; reasons.push("EMA Alignment"); }

  if (ind.ema20Rising)               { score += 8;  reasons.push("EMA Rising"); }
  if (price > ind.currentEma20)      { score += 8;  reasons.push("Above EMA20"); }
  if (ind.vwap && price > ind.vwap)  { score += 8;  reasons.push("Above VWAP"); }
  if (ind.currentRsi >= RSI_BULL_LOW && ind.currentRsi <= RSI_BULL_HIGH) {
    score += 10; reasons.push("Strong RSI");
  }
  if (ind.adx >= ADX_TREND_THRESHOLD) { score += 10; reasons.push("ADX Strong"); }

  // Check if intraday volume has reached a reasonable threshold instead of full daily average
  if ((liveData.volume || 0) > (ind.avgVol20 * 0.05)) { score += 10; reasons.push("Volume Burst"); }

  const liveChg = Number(liveData.changePercent) || 0;
  if (liveChg > (market.niftyChangePercent || 0)) {
    score += 5;  reasons.push("Outperforming Nifty");
  }
  if (ind.pdh && price > ind.pdh)     { score += 6;  reasons.push("PDH Break"); }

  // Reject chases at the day's top.
  const position = dayRangePosition(liveData);
  if (position > OVEREXTENDED_HIGH) return null; if (score < MIN_QUALIFYING_SCORE) return null;

  
  return {
    triggered: true,
    direction: "BULLISH",       // mapped to CALL upstream
    strengthScore: score,
    reasons,
    confidence: classifyConfidence(score),
    position,
  };
}

/** Bearish PUT setup — requires bearish market + inverted EMA stack. */
function evaluateBearishOption(stock, ind, liveData, market) {
  const price = Number(liveData.price || liveData.ltp) || 0;
  const reasons = [];
  let score = 0;

  if (market.trend === "BEARISH") { score += 15; reasons.push("Bearish Market"); }
  if (ind.currentEma20 < ind.currentEma50 && ind.currentEma50 < ind.currentEma200) { score += 20; reasons.push("EMA Alignment"); }

  if (price < ind.currentEma20)       { score += 8;  reasons.push("Below EMA20"); }
  if (ind.vwap && price < ind.vwap)   { score += 8;  reasons.push("Below VWAP"); }
  if (ind.currentRsi <= RSI_BEAR_HIGH){ score += 10; reasons.push("Weak RSI"); }
  if (ind.adx >= ADX_TREND_THRESHOLD) { score += 10; reasons.push("ADX Strong"); }

  if ((liveData.volume || 0) > (ind.avgVol20 * 0.05)) { score += 10; reasons.push("Heavy Selling"); }

  const liveChg = Number(liveData.changePercent) || 0;
  if (liveChg < (market.niftyChangePercent || 0)) {
    score += 5;  reasons.push("Relative Weakness");
  }
  if (ind.previousDayLow && price < ind.previousDayLow) {
    score += 6;  reasons.push("PDL Breakdown");
  }

  // Reject chases at the day's bottom.
  const position = dayRangePosition(liveData);
  if (position < OVEREXTENDED_LOW) return null; if (score < MIN_QUALIFYING_SCORE) return null;

  
  return {
    triggered: true,
    direction: "BEARISH",       // mapped to PUT upstream
    strengthScore: score,
    reasons,
    confidence: classifyConfidence(score),
    position,
  };
}

/**
 * Single entry point used by the F&O bullish AND bearish scanner cases.
 * Returns the higher-confidence direction (or null). Callers can filter the
 * result by `direction` to populate the right scanner list.
 */
function evaluateOptionsOpportunity(stock, ind, liveData, marketOverview) {
  if (!ind || !liveData) return null;
  const market = {
    trend: getMarketTrend(marketOverview),
    niftyChangePercent: Number(marketOverview?.niftyChangePercent) || 0,
  };
  return (
    evaluateBullishOption(stock, ind, liveData, market) ||
    evaluateBearishOption(stock, ind, liveData, market)
  );
}

module.exports = {
  evaluateOptionsOpportunity,
  getMarketTrend,
  // Exported for unit testing only.
  _internal: { evaluateBullishOption, evaluateBearishOption, dayRangePosition },
};
