/**
 * Translates the "Swing Tracker" Pine Script indicator into JavaScript.
 * Runs indicators: Keltner-Supertrend (triggers), Standard Supertrend (candle colors),
 * EMA High Ribbon (energy), and Trend Catcher (EMA 10/20 crossover).
 * Evaluates trade PnL dynamically on input candles series.
 */
function calculateSwingTracker(candles, options = {}) {
  if (!candles || candles.length === 0) {
    return { signals: [], currentPos: 0, entryPrice: null, summary: {} };
  }

  const sensitivity = options.sensitivity ?? 2.8;
  const keltnerLength = options.keltnerLength ?? 10;
  const atrPeriod = options.atrPeriod ?? 10;
  const factor = options.factor ?? 3.5;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // 1. Simple Moving Average (SMA)
  const sma = (data, period, index) => {
    if (index < period - 1) return null;
    let sum = 0;
    for (let i = index - period + 1; i <= index; i++) {
      sum += data[i];
    }
    return sum / period;
  };

  // 2. Exponential Moving Average (EMA)
  const ema = (data, period) => {
    if (data.length === 0) return [];
    const k = 2 / (period + 1);
    let emaArray = [data[0]];
    for (let i = 1; i < data.length; i++) {
      emaArray.push(data[i] * k + emaArray[i - 1] * (1 - k));
    }
    return emaArray;
  };

  // 3. Average True Range (ATR)
  const calculateATR = (period) => {
    const atrArray = new Array(candles.length).fill(null);
    if (candles.length === 0) return atrArray;

    let trSum = 0;
    for (let i = 0; i < candles.length; i++) {
      const high = highs[i];
      const low = lows[i];
      const prevClose = i > 0 ? closes[i - 1] : closes[0];
      const tr = i === 0 
        ? (high - low) 
        : Math.max(high - low, Math.max(Math.abs(high - prevClose), Math.abs(low - prevClose)));
      
      if (i < period) {
        trSum += tr;
        if (i === period - 1) {
          atrArray[i] = trSum / period;
        }
      } else {
        atrArray[i] = (atrArray[i - 1] * (period - 1) + tr) / period;
      }
    }
    return atrArray;
  };

  // 4. Keltner-channel-based Modified Supertrend (Buy/Sell Triggers)
  // Faithfully replicates Pine Script's supertrend() function:
  // - rangec = upperKeltner - lowerKeltner = 2*(high-low)
  // - upperBand = close + sensitivity * rangec
  // - lowerBand = close - sensitivity * rangec
  // - direction uses prevSuperTrend === prevUpperBand (Pine's nz() default = 0)
  const keltnerSupertrend = () => {
    const superTrendVal = new Array(candles.length).fill(null);
    const upperBandArr = new Array(candles.length).fill(null);
    const lowerBandArr = new Array(candles.length).fill(null);
    const direction = new Array(candles.length).fill(null);

    for (let i = 0; i < candles.length; i++) {
      const ma = sma(closes, keltnerLength, i);
      if (ma === null) continue;

      // Pine: rangec = upperKeltner - lowerKeltner = 2*(high-low)
      const rangeKeltner = 2 * (highs[i] - lows[i]);

      let upperBand = closes[i] + sensitivity * rangeKeltner;
      let lowerBand = closes[i] - sensitivity * rangeKeltner;

      // Pine: prevLowerBand = nz(lowerBand[1]) = 0 if na
      const prevLowerBand = (i > 0 && lowerBandArr[i - 1] !== null) ? lowerBandArr[i - 1] : 0;
      const prevUpperBand = (i > 0 && upperBandArr[i - 1] !== null) ? upperBandArr[i - 1] : 0;
      const prevClose = i > 0 ? closes[i - 1] : 0;

      // Pine := assignment (locking bands)
      lowerBand = (lowerBand > prevLowerBand || prevClose < prevLowerBand) ? lowerBand : prevLowerBand;
      upperBand = (upperBand < prevUpperBand || prevClose > prevUpperBand) ? upperBand : prevUpperBand;

      upperBandArr[i] = upperBand;
      lowerBandArr[i] = lowerBand;

      // Pine: direction based on prevSuperTrend vs prevUpperBand
      const prevST = i > 0 ? superTrendVal[i - 1] : null;
      const prevUB = i > 0 ? upperBandArr[i - 1] : null;

      let dir;
      if (prevST === null) {
        // First valid bar (na(rangec[1]) in Pine) => default direction 1 (sell mode)
        dir = 1;
      } else if (prevST === prevUB) {
        // Previous was in sell mode (supertrend = upper band above price)
        dir = closes[i] > upperBand ? -1 : 1;
      } else {
        // Previous was in buy mode (supertrend = lower band below price)
        dir = closes[i] < lowerBand ? 1 : -1;
      }

      const currentSuperTrend = dir === -1 ? lowerBand : upperBand;
      superTrendVal[i] = currentSuperTrend;
      direction[i] = dir;
    }

    return { superTrendVal, direction };
  };

  const { superTrendVal } = keltnerSupertrend();

  // 5. Standard Supertrend (Used for candle body colors in chart)
  // Matches Pine Script's ta.supertrend(factor, atrPeriod)
  const stdST = (() => {
    const atr = calculateATR(atrPeriod);
    const superTrendVal = new Array(candles.length).fill(null);
    const upperBandArrST = new Array(candles.length).fill(null);
    const lowerBandArrST = new Array(candles.length).fill(null);

    for (let i = 0; i < candles.length; i++) {
      if (atr[i] === null) continue;

      const atrVal = atr[i];
      const mid = (highs[i] + lows[i]) / 2;
      let upperBand = mid + factor * atrVal;
      let lowerBand = mid - factor * atrVal;

      const prevLowerBand = (i > 0 && lowerBandArrST[i - 1] !== null) ? lowerBandArrST[i - 1] : 0;
      const prevUpperBand = (i > 0 && upperBandArrST[i - 1] !== null) ? upperBandArrST[i - 1] : 0;
      const prevClose = i > 0 ? closes[i - 1] : 0;

      lowerBand = (lowerBand > prevLowerBand || prevClose < prevLowerBand) ? lowerBand : prevLowerBand;
      upperBand = (upperBand < prevUpperBand || prevClose > prevUpperBand) ? upperBand : prevUpperBand;

      upperBandArrST[i] = upperBand;
      lowerBandArrST[i] = lowerBand;

      const prevST = i > 0 ? superTrendVal[i - 1] : null;
      const prevUB = i > 0 ? upperBandArrST[i - 1] : null;

      let dir;
      if (prevST === null) {
        dir = 1;
      } else if (prevST === prevUB) {
        dir = closes[i] > upperBand ? -1 : 1;
      } else {
        dir = closes[i] < lowerBand ? 1 : -1;
      }

      const currentSuperTrend = dir === -1 ? lowerBand : upperBand;
      superTrendVal[i] = currentSuperTrend;
    }

    return { superTrendVal };
  })();

  // 6. EMA Ribbon (15 periods of High price EMAs: 9 to 51)
  const emaRibbonPeriods = [9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51];
  const emaRibbons = emaRibbonPeriods.map(p => ema(highs, p));

  // 7. Trend Catcher (EMA 10 vs EMA 20 crossover on Close prices)
  const ema10 = ema(closes, 10);
  const ema20 = ema(closes, 20);

  const signals = [];
  let currentPos = 0; // 1 for Long, -1 for Short
  let entryPrice = null;
  let totalPointsWon = 0;
  let totalPointsLost = 0;
  let winningTrades = 0;
  let losingTrades = 0;

  for (let i = 1; i < candles.length; i++) {
    const close = closes[i];
    const prevClose = closes[i - 1];
    const stVal = superTrendVal[i];
    const prevStVal = superTrendVal[i - 1];

    if (stVal === null || prevStVal === null) continue;

    const bull = prevClose <= prevStVal && close > stVal;
    const bear = prevClose >= prevStVal && close < stVal;

    let action = null;
    let tradePnl = null;

    if (bull) {
      action = "BUY";
      // Close out previous Short position and tally stats
      if (currentPos === -1 && entryPrice !== null) {
        tradePnl = entryPrice - close;
        if (tradePnl > 0) {
          totalPointsWon += tradePnl;
          winningTrades += 1;
        } else {
          totalPointsLost += Math.abs(tradePnl);
          losingTrades += 1;
        }
      }
      currentPos = 1;
      entryPrice = close;
    } else if (bear) {
      action = "SELL";
      // Close out previous Long position and tally stats
      if (currentPos === 1 && entryPrice !== null) {
        tradePnl = close - entryPrice;
        if (tradePnl > 0) {
          totalPointsWon += tradePnl;
          winningTrades += 1;
        } else {
          totalPointsLost += Math.abs(tradePnl);
          losingTrades += 1;
        }
      }
      currentPos = -1;
      entryPrice = close;
    }

    // Ribbon Energy calculation (count how many ribbon EMAs are below the Close price)
    let ribbonBullishCount = 0;
    emaRibbonPeriods.forEach((p, idx) => {
      if (emaRibbons[idx] && emaRibbons[idx][i] !== undefined && close >= emaRibbons[idx][i]) {
        ribbonBullishCount++;
      }
    });

    // Trend Catcher crossover check
    const prevEma10 = ema10[i - 1];
    const prevEma20 = ema20[i - 1];
    const currEma10 = ema10[i];
    const currEma20 = ema20[i];
    const bullCross = prevEma10 <= prevEma20 && currEma10 > currEma20;
    const bearCross = prevEma10 >= prevEma20 && currEma10 < currEma20;
    const trendCatcher = bullCross ? 1 : (bearCross ? -1 : 0);

    if (action) {
      signals.push({
        date: candles[i].date,
        action,
        price: close,
        ribbonBullishCount,
        trendCatcher,
        isBullishCandle: stdST.superTrendVal[i] !== null ? (close > stdST.superTrendVal[i]) : (close > closes[i-1]),
        stats: {
          totalPointsWon: Number(totalPointsWon.toFixed(2)),
          totalPointsLost: Number(totalPointsLost.toFixed(2)),
          winningTrades,
          losingTrades,
          netPoints: Number((totalPointsWon - totalPointsLost).toFixed(2)),
          winRate: (winningTrades + losingTrades) > 0 
            ? Number(((winningTrades / (winningTrades + losingTrades)) * 100).toFixed(1)) 
            : 0
        }
      });
    }
  }

  return {
    signals,
    currentPos,
    entryPrice,
    summary: {
      totalPointsWon: Number(totalPointsWon.toFixed(2)),
      totalPointsLost: Number(totalPointsLost.toFixed(2)),
      winningTrades,
      losingTrades,
      netPoints: Number((totalPointsWon - totalPointsLost).toFixed(2)),
      winRate: (winningTrades + losingTrades) > 0 
        ? Number(((winningTrades / (winningTrades + losingTrades)) * 100).toFixed(1)) 
        : 0
    }
  };
}

module.exports = {
  calculateSwingTracker
};
