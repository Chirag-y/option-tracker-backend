function ema(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  let emaArray = [values[0]];

  for (let i = 1; i < values.length; i++) {
    emaArray.push(values[i] * k + emaArray[i - 1] * (1 - k));
  }

  return emaArray;
}

function wma(values, period) {
  const result = [];

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    let weightedSum = 0;
    let weightTotal = 0;

    for (let j = 0; j < period; j++) {
      const weight = j + 1;
      weightedSum += values[i - period + 1 + j] * weight;
      weightTotal += weight;
    }

    result.push(weightedSum / weightTotal);
  }

  return result;
}

function EHMA(closePrices, length = 16) {
  if (closePrices.length < length) return new Array(closePrices.length).fill(null);

  // Correct HMA formula: Fast EMA uses Math.round(length/2)
  const ema1 = ema(closePrices, Math.round(length / 2));
  const ema2 = ema(closePrices, length);

  const diff = ema1.map((v, i) => (2 * v) - ema2[i]);

  return ema(diff, Math.round(Math.sqrt(length)));
}

function calculateHullSignals(candles) {
  if (!candles || candles.length < 4) return [];

  const closes = candles.map(c => c.close);
  const hull = EHMA(closes, 16);
  const ema100 = ema(closes, 100);
  const results = [];

  for (let i = 3; i < candles.length; i++) {
    const mhull = hull[i];
    const shull = hull[i - 2];
    const prevHull = hull[i - 1];
    const emaLine = ema100[i];
    if (mhull === null || shull === null || prevHull === null || emaLine === null) continue;
    const close = candles[i].close;
    const isRisky = close < emaLine || close < mhull;
    const buySignal = hull[i - 2] >= hull[i - 1] && shull < mhull;
    const sellSignal = hull[i - 2] <= hull[i - 1] && shull > mhull;
    let signal = null;
    let strength = null;
    if (buySignal) {
      signal = "CALL";
      strength = (close > mhull && close > shull) ? "STRONG" : "RISKY";
    } else if (sellSignal) {
      signal = "PUT";
      strength = (close < mhull && close < shull) ? "STRONG" : "RISKY";
    }
    if (signal) {
      results.push({
        date: candles[i].date,
        signal,
        strength,
        isRisky,
        ltp: close,
        mhull: Number(mhull.toFixed(2)),
        shull: Number(shull.toFixed(2)),
        ema100: Number(emaLine.toFixed(2))
      });
    }
  }
  return results;
}

function generateIndexTrades(candles, targetPoints, slPoints, symbol = "NIFTY") {
  if (!candles || candles.length < 4) return [];

  const closes = candles.map(c => c.close);
  const hull = EHMA(closes, 16);
  const ema100 = ema(closes, 100);
  const trades = [];

  const strikeStep = symbol === "NIFTY" ? 50 : 100;
  const basePremium = symbol === "NIFTY" ? 120 : (symbol === "BANKNIFTY" ? 350 : 400);

  let currentTrade = null;

  for (let i = 3; i < candles.length; i++) {
    const close = candles[i].close;
    const date = candles[i].date;
    const mhull = hull[i];
    const shull = hull[i - 2];
    const prevHull = hull[i - 1];

    if (mhull === null || shull === null || prevHull === null) continue;

    // Check if we need to exit the current trade first
    if (currentTrade) {
      let exitTrade = false;
      let exitReason = "";
      let exitPrice = close;
      let optionExitPrice = null;

      // Calculate Option price at current candle
      let optionCurrentPrice = currentTrade.optionEntryPrice;
      if (currentTrade.direction === "CALL") {
        optionCurrentPrice += (close - currentTrade.entryPrice) * 0.5;
      } else {
        optionCurrentPrice += (currentTrade.entryPrice - close) * 0.5;
      }
      optionCurrentPrice = Number(Math.max(1.0, optionCurrentPrice).toFixed(1));
      currentTrade.optionCurrentPrice = optionCurrentPrice;

      const optionPnL = optionCurrentPrice - currentTrade.optionEntryPrice;

      // Enforce 3:15 PM close (no carry forwarding)
      const parts = date.split("T");
      const timeStr = parts.length > 1 ? parts[1].substring(0, 5) : "";
      if (timeStr >= "15:15") {
        exitTrade = true;
        exitReason = "3:15 PM CLOSE";
        exitPrice = close;
        optionExitPrice = optionCurrentPrice;
      }

      // Check SL / Target in OPTIONS points
      if (!exitTrade) {
        if (optionPnL >= targetPoints) {
          exitTrade = true;
          exitReason = "TARGET HIT";
          exitPrice = close;
          optionExitPrice = currentTrade.optionEntryPrice + targetPoints;
        } else if (optionPnL <= -slPoints) {
          exitTrade = true;
          exitReason = "SL HIT";
          exitPrice = close;
          optionExitPrice = Number(Math.max(1.0, currentTrade.optionEntryPrice - slPoints).toFixed(1));
        }
      }

      // Check reverse trend signal
      if (!exitTrade) {
        const reverseSignal = currentTrade.direction === "CALL" 
          ? (hull[i - 2] <= hull[i - 1] && shull > mhull) // PUT trigger
          : (hull[i - 2] >= hull[i - 1] && shull < mhull); // CALL trigger

        if (reverseSignal) {
          exitTrade = true;
          exitReason = "TREND REVERSAL";
          exitPrice = close;
          optionExitPrice = optionCurrentPrice;
        }
      }

      if (exitTrade) {
        currentTrade.exitDate = date;
        currentTrade.exitPrice = Number(exitPrice.toFixed(2));
        currentTrade.optionExitPrice = optionExitPrice;
        currentTrade.optionCurrentPrice = optionExitPrice;
        currentTrade.pnlAmount = Number((optionExitPrice - currentTrade.optionEntryPrice).toFixed(1));
        currentTrade.pnlPct = Number(((currentTrade.pnlAmount / currentTrade.optionEntryPrice) * 100).toFixed(2));
        currentTrade.status = currentTrade.pnlAmount >= 0 ? "PROFIT" : "LOSS";
        currentTrade.type = `EXIT (${exitReason})`;
        currentTrade.result = currentTrade.status;
        
        trades.push(currentTrade);
        currentTrade = null;
      }
    }

    // Check for new entry signal (only if not currently in a trade and before 3:15 PM)
    if (!currentTrade) {
      const parts = date.split("T");
      const timeStr = parts.length > 1 ? parts[1].substring(0, 5) : "";
      
      if (timeStr < "15:15") {
        const buySignal = hull[i - 2] >= hull[i - 1] && shull < mhull;
        const sellSignal = hull[i - 2] <= hull[i - 1] && shull > mhull;

        let signal = null;
        let strength = null;

        if (buySignal) {
          signal = "CALL";
          strength = (close > mhull && close > shull) ? "STRONG" : "RISKY";
        } else if (sellSignal) {
          signal = "PUT";
          strength = (close < mhull && close < shull) ? "STRONG" : "RISKY";
        }

        if (signal) {
          const isRisky = close < ema100[i] || close < mhull;
          let strikeMin = 200, strikeMax = 250;
          if (symbol === "BANKNIFTY") {
            strikeMin = 500;
            strikeMax = 650;
          } else if (symbol === "SENSEX") {
            strikeMin = 550;
            strikeMax = 700;
          }

          const baseStrike = Math.round(close / strikeStep) * strikeStep;
          let bestStrike = baseStrike;
          let bestPremium = basePremium;
          let foundRange = false;

          const searchRange = 25;
          for (let step = -searchRange; step <= searchRange; step++) {
            const strikeCandidate = baseStrike + step * strikeStep;
            let premiumCandidate = basePremium;
            if (signal === "CALL") {
              premiumCandidate += (close - strikeCandidate) * 0.5;
            } else {
              premiumCandidate += (strikeCandidate - close) * 0.5;
            }

            if (premiumCandidate >= strikeMin && premiumCandidate <= strikeMax) {
              bestStrike = strikeCandidate;
              bestPremium = premiumCandidate;
              foundRange = true;
              break;
            }
          }

          if (!foundRange) {
            let minDiff = Infinity;
            for (let step = -searchRange; step <= searchRange; step++) {
              const strikeCandidate = baseStrike + step * strikeStep;
              let premiumCandidate = basePremium;
              if (signal === "CALL") {
                premiumCandidate += (close - strikeCandidate) * 0.5;
              } else {
                premiumCandidate += (strikeCandidate - close) * 0.5;
              }
              const avg = (strikeMin + strikeMax) / 2;
              const diff = Math.abs(premiumCandidate - avg);
              if (diff < minDiff) {
                minDiff = diff;
                bestStrike = strikeCandidate;
                bestPremium = premiumCandidate;
              }
            }
          }

          const selectedStrike = bestStrike;
          const selectedPremium = Number(bestPremium.toFixed(1));

          const suffix = signal === "CALL" ? "CE" : "PE";
          const optionName = `${symbol} ${selectedStrike} ${suffix}`;

          currentTrade = {
            type: signal,
            direction: signal,
            entryDate: date,
            entryPrice: close,
            exitDate: "—",
            exitPrice: null,
            currentPrice: close,
            targetPrice: signal === "CALL" ? close + (targetPoints / 0.5) : close - (targetPoints / 0.5),
            stopLossPrice: signal === "CALL" ? close - (slPoints / 0.5) : close + (slPoints / 0.5),
            pnlAmount: 0,
            pnlPct: 0,
            status: "OPEN",
            signalStrength: strength,
            optionName,
            optionEntryPrice: selectedPremium,
            optionExitPrice: null,
            optionCurrentPrice: selectedPremium,
            strike: selectedStrike,
            isRisky: isRisky,
            timeframe: candles[i].timeframe || "3M"
          };
        }
      }
    }
  }

  // Handle open trade at the end
  if (currentTrade) {
    const latestClose = candles[candles.length - 1].close;
    currentTrade.currentPrice = latestClose;
    
    let optionCurrentPrice = currentTrade.optionEntryPrice;
    if (currentTrade.direction === "CALL") {
      optionCurrentPrice += (latestClose - currentTrade.entryPrice) * 0.5;
    } else {
      optionCurrentPrice += (currentTrade.entryPrice - latestClose) * 0.5;
    }
    optionCurrentPrice = Number(Math.max(1.0, optionCurrentPrice).toFixed(1));
    currentTrade.optionCurrentPrice = optionCurrentPrice;
    currentTrade.pnlAmount = Number((optionCurrentPrice - currentTrade.optionEntryPrice).toFixed(1));
    currentTrade.pnlPct = Number(((currentTrade.pnlAmount / currentTrade.optionEntryPrice) * 100).toFixed(2));
    currentTrade.status = "OPEN";
    trades.push(currentTrade);
  }

  return trades;
}

module.exports = {
  calculateHullSignals,
  EHMA,
  generateIndexTrades
};
