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

  // Mirrors the shared Pine script's EHMA helper.
  return ema(ema(closePrices, length), Math.round(Math.sqrt(length)));
}

function getSignalInfo(candles, hull, ema100, i) {
  const mhull = hull[i];
  const shull = hull[i - 2];
  const prevMhull = hull[i - 1];
  const prevShull = hull[i - 3];
  const emaLine = ema100[i];
  const signalEpsilon = 0.1;
  const upperLine = Math.max(mhull, emaLine);
  const lowerLine = Math.min(mhull, emaLine);

  if (
    mhull === null ||
    shull === null ||
    prevMhull === null ||
    prevShull === null ||
    emaLine === null
  ) {
    return null;
  }

  const close = candles[i].close;
  const candleColor = close > candles[i].open ? "GREEN" : close < candles[i].open ? "RED" : "DOJI";
  const aboveUpperLine = close > upperLine + signalEpsilon;
  const belowLowerLine = close < lowerLine - signalEpsilon;

  if (aboveUpperLine) {
    return {
      signal: "CALL",
      strength: "STRONG",
      isRisky: false,
      mhull,
      shull,
      emaLine
    };
  }

  if (belowLowerLine) {
    return {
      signal: "PUT",
      strength: "STRONG",
      isRisky: false,
      mhull,
      shull,
      emaLine
    };
  }

  if (candleColor === "GREEN" && close > lowerLine + signalEpsilon) {
    return {
      signal: "CALL",
      strength: "RISKY",
      isRisky: true,
      mhull,
      shull,
      emaLine
    };
  }

  if (candleColor === "RED" && close < upperLine - signalEpsilon) {
    return {
      signal: "PUT",
      strength: "RISKY",
      isRisky: true,
      mhull,
      shull,
      emaLine
    };
  }

  return null;
}

function isMorningTrendReversalWindow(timeStr) {
  return timeStr >= "09:16" && timeStr <= "10:15";
}

function candleCrossesBothLines(candle, signalInfo) {
  if (!candle || !signalInfo) return false;
  const upperLine = Math.max(signalInfo.mhull, signalInfo.emaLine);
  const lowerLine = Math.min(signalInfo.mhull, signalInfo.emaLine);
  return candle.high >= upperLine && candle.low <= lowerLine;
}

function candleCrossesEitherLine(candle, signalInfo) {
  if (!candle || !signalInfo) return false;
  const upperLine = Math.max(signalInfo.mhull, signalInfo.emaLine);
  const lowerLine = Math.min(signalInfo.mhull, signalInfo.emaLine);
  const crossesUpper = candle.high >= upperLine && candle.low <= upperLine;
  const crossesLower = candle.high >= lowerLine && candle.low <= lowerLine;
  return crossesUpper || crossesLower;
}

function candleClosesBeyondReversalLine(candle, signalInfo, direction) {
  if (!candle || !signalInfo) return false;
  const upperLine = Math.max(signalInfo.mhull, signalInfo.emaLine);
  const lowerLine = Math.min(signalInfo.mhull, signalInfo.emaLine);

  if (direction === "CALL") {
    return candle.close < lowerLine;
  }

  if (direction === "PUT") {
    return candle.close > upperLine;
  }

  return false;
}

function hasEntryBreakoutConfirmation(candle, previousCandle, signalInfo) {
  if (!candle || !signalInfo) return false;

  const upperLine = Math.max(signalInfo.mhull, signalInfo.emaLine);
  const lowerLine = Math.min(signalInfo.mhull, signalInfo.emaLine);
  const touchEpsilon = 0.1;
  const candleColor = candle.close > candle.open ? "GREEN" : candle.close < candle.open ? "RED" : "DOJI";
  const closeTouchesLine =
    Math.abs(candle.close - upperLine) <= touchEpsilon ||
    Math.abs(candle.close - lowerLine) <= touchEpsilon;

  if (signalInfo.signal === "CALL") {
    if (candle.low > upperLine + touchEpsilon) return true;
    if (candle.low > lowerLine + touchEpsilon && candleColor === "GREEN") return true;
    if (candleColor === "GREEN" && candle.close > lowerLine + touchEpsilon) {
      return closeTouchesLine
        ? Boolean(previousCandle && previousCandle.close > lowerLine + touchEpsilon)
        : false;
    }
    return false;
  }

  if (signalInfo.signal === "PUT") {
    if (candle.high < lowerLine - touchEpsilon) return true;
    if (candle.high < upperLine - touchEpsilon && candleColor === "RED") return true;
    if (candleColor === "RED" && candle.close < upperLine - touchEpsilon) {
      return closeTouchesLine
        ? Boolean(previousCandle && previousCandle.close < upperLine - touchEpsilon)
        : false;
    }
    return false;
  }

  return false;
}

function getExitPnl(indexPnL, exitReason, slPoints) {
  if (exitReason === "SL HIT") {
    return Number((-slPoints).toFixed(2));
  }

  return Number(indexPnL.toFixed(2));
}

function calculateTrailExitPrice(trade, candle) {
  if (trade.direction === "CALL") {
    return Number((trade.trailingStopPrice ?? candle.low).toFixed(2));
  }

  return Number((trade.trailingStopPrice ?? candle.high).toFixed(2));
}

function calculateHullSignals(candles) {
  if (!candles || candles.length < 4) return [];

  const closes = candles.map(c => c.close);
  const hull = EHMA(closes, 16);
  const ema100 = ema(closes, 100);
  const results = [];

  for (let i = 3; i < candles.length; i++) {
    const signalInfo = getSignalInfo(candles, hull, ema100, i);
    if (!signalInfo) continue;

    results.push({
      date: candles[i].date,
      signal: signalInfo.signal,
      strength: signalInfo.strength,
      isRisky: signalInfo.isRisky,
      ltp: candles[i].close,
      mhull: Number(signalInfo.mhull.toFixed(2)),
      shull: Number(signalInfo.shull.toFixed(2)),
      ema100: Number(signalInfo.emaLine.toFixed(2))
    });
  }

  return results;
}

async function generateIndexTrades(candles, targetPoints, slPoints, symbol = "NIFTY") {
  if (!candles || candles.length < 4) return [];

  const closes = candles.map(c => c.close);
  const hull = EHMA(closes, 16);
  const ema100 = ema(closes, 100);
  const tightenStopAfterProfitPoints = 15;
  const tightenedStopPoints = 15;
  const trades = [];
  const openTrades = [];
  const directionCooldownState = {
    CALL: null,
    PUT: null
  };
  let activeDayKey = null;
  let previousCandle = null;

  function closeOpenTradesForDayReset(resetDate, resetClose) {
    for (let t = openTrades.length - 1; t >= 0; t--) {
      const trade = openTrades[t];
      const indexPnL = trade.direction === "CALL"
        ? resetClose - trade.entryPrice
        : trade.entryPrice - resetClose;
      const exitPnl = getExitPnl(indexPnL, "DAY RESET", slPoints);

      trade.exitDate = resetDate;
      trade.exitPrice = Number(resetClose.toFixed(2));
      trade.pnlAmount = exitPnl;
      trade.pnlPct = Number(((trade.pnlAmount / trade.entryPrice) * 100).toFixed(2));
      trade.status = trade.pnlAmount >= 0 ? "PROFIT" : "LOSS";
      trade.type = "EXIT (DAY RESET)";
      trade.result = trade.status;

      if (trade.targetReached) {
        directionCooldownState[trade.direction] = {
          exitTime: new Date(resetDate).getTime(),
          exitClose: resetClose,
          cooldownCloses: []
        };
      }

      trades.push(trade);
      openTrades.splice(t, 1);
    }
  }

  for (let i = 3; i < candles.length; i++) {
    const close = candles[i].close;
    const date = candles[i].date;
    const candleTime = new Date(date).getTime();
    const dayKey = date.split("T")[0];

    if (activeDayKey && dayKey !== activeDayKey) {
      if (previousCandle) {
        closeOpenTradesForDayReset(previousCandle.date, previousCandle.close);
      }

      directionCooldownState.CALL = null;
      directionCooldownState.PUT = null;
    }

    activeDayKey = dayKey;
    previousCandle = candles[i];

    let timeStr = "";
    try {
      const parsedDate = new Date(date);
      if (!isNaN(parsedDate.getTime())) {
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Kolkata",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit"
        });
        timeStr = formatter.format(parsedDate);
      }
    } catch (err) {}

    const signalInfo = getSignalInfo(candles, hull, ema100, i);
    const isLastCandle = i === candles.length - 1;
    const candle = candles[i];
    const candleColor = candle.close > candle.open ? "GREEN" : candle.close < candle.open ? "RED" : "DOJI";

    for (const direction of ["CALL", "PUT"]) {
      const cooldownState = directionCooldownState[direction];
      if (!cooldownState) continue;

      if (candleTime > cooldownState.exitTime && cooldownState.cooldownCloses.length < 3) {
        cooldownState.cooldownCloses.push(close);
      }
    }

    for (let t = openTrades.length - 1; t >= 0; t--) {
      const trade = openTrades[t];
      let exitTrade = false;
      let exitReason = "";

      if (timeStr >= "15:15") {
        exitTrade = true;
        exitReason = "3:15 PM CLOSE";
      } else {
        const targetPrice = trade.direction === "CALL"
          ? trade.entryPrice + targetPoints
          : trade.entryPrice - targetPoints;
        const favorableMove = trade.direction === "CALL"
          ? candle.high - trade.entryPrice
          : trade.entryPrice - candle.low;
        const activeStopPoints = favorableMove >= tightenStopAfterProfitPoints
          ? tightenedStopPoints
          : slPoints;
        const initialStopPrice = trade.direction === "CALL"
          ? trade.entryPrice - activeStopPoints
          : trade.entryPrice + activeStopPoints;

        if (!trade.trailingActive) {
          if (
            (trade.direction === "CALL" && candle.high >= targetPrice) ||
            (trade.direction === "PUT" && candle.low <= targetPrice)
          ) {
            trade.trailingActive = true;
            trade.targetReached = true;
            trade.extremePrice = trade.direction === "CALL" ? candle.high : candle.low;
            trade.trailingStopPrice = trade.direction === "CALL"
              ? Number((trade.extremePrice - 10).toFixed(2))
              : Number((trade.extremePrice + 10).toFixed(2));
          }
        }

        if (!trade.trailingActive && (
          (trade.direction === "CALL" && candle.low <= initialStopPrice) ||
          (trade.direction === "PUT" && candle.high >= initialStopPrice)
        )) {
          exitTrade = true;
          exitReason = "SL HIT";
        } else if (trade.trailingActive) {
          if (trade.direction === "CALL") {
            trade.extremePrice = Math.max(trade.extremePrice || trade.entryPrice, candle.high);
            trade.trailingStopPrice = Number((trade.extremePrice - 10).toFixed(2));
            if (candle.low <= trade.trailingStopPrice) {
              exitTrade = true;
              exitReason = "TRAIL SL HIT";
            }
          } else {
            trade.extremePrice = Math.min(trade.extremePrice || trade.entryPrice, candle.low);
            trade.trailingStopPrice = Number((trade.extremePrice + 10).toFixed(2));
            if (candle.high >= trade.trailingStopPrice) {
              exitTrade = true;
              exitReason = "TRAIL SL HIT";
            }
          }
        }

        if (!exitTrade && signalInfo &&
          ((trade.direction === "CALL" && signalInfo.signal === "PUT") ||
           (trade.direction === "PUT" && signalInfo.signal === "CALL"))
        ) {
          const allowReversal = isMorningTrendReversalWindow(timeStr)
            ? candleCrossesBothLines(candle, signalInfo) && candleClosesBeyondReversalLine(candle, signalInfo, trade.direction)
            : candleClosesBeyondReversalLine(candle, signalInfo, trade.direction);
          if (allowReversal && hasEntryBreakoutConfirmation(candle, candles[i - 1], signalInfo)) {
            exitTrade = true;
            exitReason = "TREND REVERSAL";
          }
        }
      }

      if (!exitTrade) continue;

      const isTrailExit = exitReason === "TRAIL SL HIT";
      const exitPrice = exitReason === "SL HIT"
        ? (trade.direction === "CALL" ? trade.entryPrice - slPoints : trade.entryPrice + slPoints)
        : isTrailExit
          ? calculateTrailExitPrice(trade, candle)
          : Number(close.toFixed(2));

      trade.exitDate = date;
      trade.exitPrice = Number(exitPrice.toFixed(2));
      trade.pnlAmount = Number((trade.direction === "CALL"
        ? trade.exitPrice - trade.entryPrice
        : trade.entryPrice - trade.exitPrice).toFixed(2));
      trade.pnlPct = Number(((trade.pnlAmount / trade.entryPrice) * 100).toFixed(2));
      trade.status = trade.pnlAmount >= 0 ? "PROFIT" : "LOSS";
      trade.type = `EXIT (${exitReason})`;
      trade.result = trade.status;

      if (trade.targetReached) {
        directionCooldownState[trade.direction] = {
          exitTime: candleTime,
          exitClose: close,
          cooldownCloses: []
        };
      }

      trades.push(trade);
      openTrades.splice(t, 1);
    }

    if (!signalInfo || timeStr >= "15:15") continue;

    // Only enter on confirmed candle closes. The live forming candle is ignored
    // so the entry waits for the 1M/3M bar to close first.
    if (isLastCandle && timeStr < "15:15") continue;

    if (
      (signalInfo.signal === "CALL" && candleColor !== "GREEN") ||
      (signalInfo.signal === "PUT" && candleColor !== "RED")
    ) {
      continue;
    }

    if (!hasEntryBreakoutConfirmation(candle, candles[i - 1], signalInfo)) {
      continue;
    }

    const hasOpenSameDirection = openTrades.some((trade) => trade.direction === signalInfo.signal);
    if (hasOpenSameDirection) {
      continue;
    }

    if (openTrades.length > 0) {
      continue;
    }

    const cooldownState = directionCooldownState[signalInfo.signal];
    if (cooldownState) {
      if (cooldownState.cooldownCloses.length < 3) {
        continue;
      }

      const breakoutWindow = [cooldownState.exitClose, ...cooldownState.cooldownCloses];
      const breakoutLevel = signalInfo.signal === "CALL"
        ? Math.max(...breakoutWindow)
        : Math.min(...breakoutWindow);

      if (
        (signalInfo.signal === "CALL" && close <= breakoutLevel) ||
        (signalInfo.signal === "PUT" && close >= breakoutLevel)
      ) {
        continue;
      }

      directionCooldownState[signalInfo.signal] = null;
    }

    const signal = signalInfo.signal;
    const oppositeDirection = signal === "CALL" ? "PUT" : "CALL";

    if (directionCooldownState[oppositeDirection]) {
      directionCooldownState[oppositeDirection] = null;
    }

    openTrades.push({
      type: signal,
      direction: signal,
      entryDate: date,
      entryPrice: close,
      exitDate: "-",
      exitPrice: null,
      currentPrice: close,
      targetPrice: signal === "CALL" ? close + targetPoints : close - targetPoints,
      stopLossPrice: signal === "CALL" ? close - slPoints : close + slPoints,
      pnlAmount: 0,
      pnlPct: 0,
      status: "OPEN",
      signalStrength: signalInfo.strength,
      isRisky: signalInfo.isRisky,
      timeframe: candles[i].timeframe || "3M",
      signalKind: signal,
      targetReached: false,
      trailingActive: false,
      trailingStopPrice: null,
      extremePrice: close
    });
  }

  if (openTrades.length > 0) {
    const lastCandle = candles[candles.length - 1];
    for (const trade of openTrades) {
      trade.currentPrice = lastCandle.close;
      trade.pnlAmount = Number((trade.direction === "CALL"
        ? lastCandle.close - trade.entryPrice
        : trade.entryPrice - lastCandle.close).toFixed(2));
      trade.pnlPct = Number(((trade.pnlAmount / trade.entryPrice) * 100).toFixed(2));
      trade.status = "OPEN";
      trades.push(trade);
    }
  }

  return trades;
}

module.exports = {
  calculateHullSignals,
  EHMA,
  generateIndexTrades
};
