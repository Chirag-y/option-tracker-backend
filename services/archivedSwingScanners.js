/**
 * Archived swing scanner logic.
 *
 * This file is intentionally not imported by the live scanner engine.
 * It exists as a temporary holding place for the retired scanners that
 * were removed from the active execution path:
 * - swing-trades
 * - swing-momentum-breakout
 * - early-swing-reversal
 */

function buildSwingTradesSignal({ rsiVal = 50, volumeRatio = 1, change = 0 }) {
  const triggered = rsiVal > 60 && volumeRatio > 1.2;
  return {
    scannerId: "swing-trades",
    triggered,
    direction: change >= 0 ? "BULLISH" : "BEARISH",
    strengthScore: Math.min(100, Math.round(rsiVal + 20))
  };
}

function buildSwingMomentumBreakoutSignal({ rsiVal = 50, volumeRatio = 1, change = 0 }) {
  const triggered = rsiVal > 60 && volumeRatio > 1.2;
  return {
    scannerId: "swing-momentum-breakout",
    triggered,
    direction: change >= 0 ? "BULLISH" : "BEARISH",
    strengthScore: Math.min(100, Math.round(rsiVal + 20))
  };
}

function buildEarlySwingReversalSignal({ ind = {}, ltp = 0, volumeRatio = 1, rsiVal = 50, liveVolume = 100000 }) {
  const ema9_5days = ind.ema9?.[ind.ema9.length - 6] || ind.ema9?.[0];
  const ema21_5days = ind.ema21?.[ind.ema21.length - 6] || ind.ema21?.[0];
  const triggered =
    ind.currentEma9 > ind.currentEma21 &&
    ema9_5days <= ema21_5days &&
    rsiVal > 55 &&
    ltp > ind.currentEma9 &&
    liveVolume > ind.avgVol10;

  return {
    scannerId: "early-swing-reversal",
    triggered,
    direction: "BULLISH",
    strengthScore: Math.min(100, Math.round(rsiVal + 15))
  };
}

module.exports = {
  buildSwingTradesSignal,
  buildSwingMomentumBreakoutSignal,
  buildEarlySwingReversalSignal
};
