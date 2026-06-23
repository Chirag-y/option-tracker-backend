/**
 * Translates the "20 May Refined" Pine Script indicator into JavaScript.
 * Runs indicators: EMA (5, 13, 20, 50, 200), VWAP, ATR (14), DMI/ADX (14)
 * and opening range breakout. Evaluates CALL/PUT triggers and trails stop losses.
 */

function calculateEMA(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calculateATR(candles, period = 14) {
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].high - candles[i].low);
      continue;
    }
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(high - low, Math.max(Math.abs(high - prevClose), Math.abs(low - prevClose))));
  }
  const atr = new Array(candles.length).fill(0);
  if (tr.length < period) return atr;
  
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  
  const k = 1 / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = tr[i] * k + atr[i - 1] * (1 - k);
  }
  return atr;
}

function calculateVWAP(candles) {
  const vwap = [];
  let sumPriceVol = 0;
  let sumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1000;
    sumPriceVol += typicalPrice * vol;
    sumVol += vol;
    vwap.push(sumPriceVol / sumVol);
  }
  return vwap;
}

function calculateDMI(candles, period = 14) {
  const tr = [];
  const dmPlus = [];
  const dmMinus = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(0);
      dmPlus.push(0);
      dmMinus.push(0);
      continue;
    }
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    const trVal = Math.max(high - low, Math.max(Math.abs(high - prevClose), Math.abs(low - prevClose)));
    tr.push(trVal);

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    if (upMove > 0 && upMove > downMove) {
      dmPlus.push(upMove);
    } else {
      dmPlus.push(0);
    }

    if (downMove > 0 && downMove > upMove) {
      dmMinus.push(downMove);
    } else {
      dmMinus.push(0);
    }
  }

  const rma = (values, period) => {
    const result = new Array(values.length).fill(0);
    if (values.length < period) return result;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    result[period - 1] = sum / period;

    const k = 1 / period;
    for (let i = period; i < candles.length; i++) {
      result[i] = values[i] * k + result[i - 1] * (1 - k);
    }
    return result;
  };

  const trSmooth = rma(tr, period);
  const dmPlusSmooth = rma(dmPlus, period);
  const dmMinusSmooth = rma(dmMinus, period);

  const diPlus = new Array(candles.length).fill(0);
  const diMinus = new Array(candles.length).fill(0);
  const dx = new Array(candles.length).fill(0);

  for (let i = period - 1; i < candles.length; i++) {
    const trS = trSmooth[i] || 1;
    diPlus[i] = (dmPlusSmooth[i] / trS) * 100;
    diMinus[i] = (dmMinusSmooth[i] / trS) * 100;

    const diff = Math.abs(diPlus[i] - diMinus[i]);
    const sum = diPlus[i] + diMinus[i] || 1;
    dx[i] = (diff / sum) * 100;
  }

  const adx = rma(dx, period);
  return { diPlus, diMinus, adx };
}

function calculateRefinedSignals(candles, isNifty = true) {
  if (!candles || candles.length < 20) {
    return { activeSide: 0, signalType: "NEUTRAL", entryPrice: 0, currentSL: 0, points: 0 };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Settings
  const mainSL = isNifty ? 30.0 : 50.0;
  const mainTP = isNifty ? 60.0 : 100.0;
  const contTP = isNifty ? 40.0 : 70.0;
  const minADXLevel = isNifty ? 20.0 : 16.0;
  const emaGapThreshold = isNifty ? 8.0 : 15.0;
  const pullbackAtrLimit = isNifty ? 0.65 : 0.80;

  // Indicators
  const fastEMA = calculateEMA(closes, 5);
  const slowEMA = calculateEMA(closes, 13);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const vwapValue = calculateVWAP(candles);
  const atrValue = calculateATR(candles, 14);
  const { diPlus, diMinus, adx } = calculateDMI(candles, 14);

  // State Tracking
  let activeSide = 0; // 1 for CALL, -1 for PUT, 0 for Cash
  let entryPrice = null;
  let currentSL = null;
  let maxFavorablePrice = null;
  let lastExitBar = 0;
  let lastExitDirection = 0;
  let mainTradeCount = 0;
  let isContinuationTrade = false;
  let currentTrend = 0;
  let mainTrendCTC = null;
  let bullishMainCompleted = false;
  let bearishMainCompleted = false;
  let lastSignalType = "NEUTRAL";

  // Opening range simulation vars
  let openingRangeHigh = null;
  let openingRangeLow = null;

  const signalHistory = [];

  for (let i = 1; i < candles.length; i++) {
    const prevActiveSide = activeSide;
    const prevEntryPrice = entryPrice;

    const close = closes[i];
    const open = closes[i - 1];
    const high = highs[i];
    const low = lows[i];

    const fEma = fastEMA[i] || close;
    const sEma = slowEMA[i] || close;
    const e20 = ema20[i] || close;
    const e50 = ema50[i] || close;
    const e200 = ema200[i] || close;
    const vwap = vwapValue[i] || close;
    const atr = atrValue[i] || 5;
    const adxVal = adx[i] || 15;
    const dp = diPlus[i] || 0;
    const dm = diMinus[i] || 0;

    // Simulate opening range on first index or simple time filter
    if (i === 1) {
      openingRangeHigh = high;
      openingRangeLow = low;
    }

    const openingBreakoutBull = close > openingRangeHigh;
    const openingBreakoutBear = close < openingRangeLow;

    // Trend Calculations
    const emaGap = Math.abs(fEma - sEma);
    const fastSlope = fastEMA[i] - (fastEMA[i - 1] || fastEMA[i]);
    const slowSlope = slowEMA[i] - (slowEMA[i - 1] || slowEMA[i]);

    const strongBullTrend = fEma > sEma && emaGap > emaGapThreshold && fastSlope > 0 && slowSlope >= 0;
    const strongBearTrend = fEma < sEma && emaGap > emaGapThreshold && fastSlope < 0 && slowSlope <= 0;

    const institutionalBullBias = close > vwap && e20 > e50 && close > e200;
    const institutionalBearBias = close < vwap && e20 < e50 && close < e200;

    // Candle quality check
    const candleBody = Math.abs(close - open);
    const candleRange = Math.max(high - low, 0.05);
    const upperWick = high - Math.max(close, open);
    const lowerWick = Math.min(close, open) - low;

    const healthyBullCandle = close > open && candleBody >= candleRange * 0.35 && upperWick <= candleBody;
    const healthyBearCandle = close < open && candleBody >= candleRange * 0.35 && lowerWick <= candleBody;

    const avoidChaseBull = (close - fEma) <= atr * pullbackAtrLimit;
    const avoidChaseBear = (fEma - close) <= atr * pullbackAtrLimit;

    // Micro breaks and pullbacks
    const prevHighs = highs.slice(Math.max(0, i - 3), i);
    const prevLows = lows.slice(Math.max(0, i - 3), i);
    const recentHighBreak = close > Math.max(...prevHighs, high);
    const recentLowBreak = close < Math.min(...prevLows, low);

    const bullPullbackTouch = low <= fEma || low <= vwap;
    const bearPullbackTouch = high >= fEma || high >= vwap;

    const bullContinuationBreak = close > (highs[i - 1] || high) && close > fEma;
    const bearContinuationBreak = close < (lows[i - 1] || low) && close < fEma;

    const bullPullbackRecovery = bullPullbackTouch && close > fEma && close > vwap && close >= (highs[i - 1] || high);
    const bearPullbackRecovery = bearPullbackTouch && close < fEma && close < vwap && close <= (lows[i - 1] || low);

    const bullTrendStart = strongBullTrend && (bullContinuationBreak || bullPullbackRecovery) && healthyBullCandle && avoidChaseBull;
    const bearTrendStart = strongBearTrend && (bearContinuationBreak || bearPullbackRecovery) && healthyBearCandle && avoidChaseBear;

    const bullMomentumResume = fEma > sEma && close > fEma && close > sEma && close > vwap && fastSlope > 0 && healthyBullCandle && avoidChaseBull && recentHighBreak;
    const bearMomentumResume = fEma < sEma && close < fEma && close < sEma && close < vwap && fastSlope < 0 && healthyBearCandle && avoidChaseBear && recentLowBreak;

    const immediateGuard = i > lastExitBar;

    // ENTRY CONDITIONS
    const isBuy = activeSide === 0 && immediateGuard && adxVal > minADXLevel && dp > dm && (bullTrendStart || bullMomentumResume) && institutionalBullBias && openingBreakoutBull;
    const isSell = activeSide === 0 && immediateGuard && adxVal > minADXLevel && dm > dp && (bearTrendStart || bearMomentumResume) && institutionalBearBias && openingBreakoutBear;

    // Exit Reversal Check
    const bullishTrendFlip = fEma > sEma && close > fEma && close > vwap;
    const bearishTrendFlip = fEma < sEma && close < fEma && close < vwap;
    const reversalExit = (activeSide === -1 && bullishTrendFlip) || (activeSide === 1 && bearishTrendFlip);

    if (isBuy) {
      activeSide = 1;
      lastSignalType = "CALL";
      if (currentTrend !== 1 || !bullishMainCompleted) {
        currentTrend = 1;
        mainTradeCount++;
        isContinuationTrade = false;
        entryPrice = close;
        currentSL = Math.max(entryPrice - mainSL, sEma);
        bearishMainCompleted = false;
      } else {
        isContinuationTrade = true;
        entryPrice = close;
        currentSL = Math.max(entryPrice - mainSL, sEma);
      }
      maxFavorablePrice = high;
      lastExitDirection = 0;
    } else if (isSell) {
      activeSide = -1;
      lastSignalType = "PUT";
      if (currentTrend !== -1 || !bearishMainCompleted) {
        currentTrend = -1;
        mainTradeCount++;
        isContinuationTrade = false;
        entryPrice = close;
        currentSL = Math.min(entryPrice + mainSL, sEma);
        bullishMainCompleted = false;
      } else {
        isContinuationTrade = true;
        entryPrice = close;
        currentSL = Math.min(entryPrice + mainSL, sEma);
      }
      maxFavorablePrice = low;
      lastExitDirection = 0;
    }

    // Profit Tracking
    if (activeSide === 1 && high > maxFavorablePrice) {
      maxFavorablePrice = high;
    }
    if (activeSide === -1 && low < maxFavorablePrice) {
      maxFavorablePrice = low;
    }

    const callProfit = high - (entryPrice || close);
    const putProfit = (entryPrice || close) - low;

    // Trailing Stop shifts
    if (activeSide === 1 && callProfit >= mainTP * 0.5) {
      currentSL = Math.max(currentSL || 0, entryPrice || 0);
    }
    if (activeSide === -1 && putProfit >= mainTP * 0.5) {
      currentSL = Math.min(currentSL || 999999, entryPrice || 999999);
    }

    // Targets Hit Exits
    if (activeSide === 1 && !isContinuationTrade && callProfit >= mainTP) {
      mainTrendCTC = entryPrice;
      bullishMainCompleted = true;
      lastSignalType = "EXIT (T1 HIT)";
      activeSide = 0;
      lastExitBar = i;
    } else if (activeSide === -1 && !isContinuationTrade && putProfit >= mainTP) {
      mainTrendCTC = entryPrice;
      bearishMainCompleted = true;
      lastSignalType = "EXIT (T1 HIT)";
      activeSide = 0;
      lastExitBar = i;
    } else if (activeSide === 1 && isContinuationTrade && callProfit >= contTP) {
      lastSignalType = "EXIT (CONT TP)";
      activeSide = 0;
      lastExitBar = i;
    } else if (activeSide === -1 && isContinuationTrade && putProfit >= contTP) {
      lastSignalType = "EXIT (CONT TP)";
      activeSide = 0;
      lastExitBar = i;
    }

    // SL hit exits
    const hardSLBuy = activeSide === 1 && low <= (currentSL || 0);
    const hardSLSell = activeSide === -1 && high >= (currentSL || 999999);
    const finalExit = hardSLBuy || hardSLSell || reversalExit;

    if (finalExit && activeSide !== 0) {
      lastExitDirection = activeSide;
      lastSignalType = hardSLBuy || hardSLSell ? "EXIT (SL HIT)" : "EXIT (REVERSAL)";
      activeSide = 0;
      currentTrend = 0;
      bullishMainCompleted = false;
      bearishMainCompleted = false;
      lastExitBar = i;
    }

    const currentLTP = close;
    let pnlPoints = 0;
    if (activeSide !== 0) {
      pnlPoints = activeSide === 1 ? (currentLTP - entryPrice) : (entryPrice - currentLTP);
    } else if (prevActiveSide !== 0) {
      pnlPoints = prevActiveSide === 1 ? (currentLTP - prevEntryPrice) : (prevEntryPrice - currentLTP);
    }

    signalHistory.push({
      date: candles[i].date,
      price: currentLTP,
      activeSide,
      signalType: activeSide === 1 ? "CALL" : (activeSide === -1 ? "PUT" : lastSignalType),
      entryPrice: entryPrice || 0,
      currentSL: currentSL || 0,
      points: Number(pnlPoints.toFixed(2))
    });
  }

  const currentLTP = closes[closes.length - 1];
  const pnlPoints = activeSide !== 0 
    ? (activeSide === 1 ? (currentLTP - entryPrice) : (entryPrice - currentLTP))
    : 0;

  return {
    activeSide, // 1: CALL, -1: PUT, 0: CASH
    signalType: activeSide === 1 ? "CALL" : (activeSide === -1 ? "PUT" : lastSignalType),
    entryPrice: entryPrice || 0,
    currentSL: currentSL || 0,
    points: Number(pnlPoints.toFixed(2)),
    history: signalHistory
  };
}

module.exports = {
  calculateRefinedSignals
};
