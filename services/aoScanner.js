const ema = (prices, period) => {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  let emaArray = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
};

const sma = (prices, period) => {
  if (prices.length < period) return new Array(prices.length).fill(null);
  let sum = 0;
  const result = [];
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i];
    if (i < period - 1) {
      result.push(null);
    } else {
      if (i >= period) sum -= prices[i - period];
      result.push(sum / period);
    }
  }
  return result;
};

const rsi = (prices, period = 14) => {
  const rsiArray = new Array(prices.length).fill(null);
  if (prices.length <= period) return rsiArray;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsiArray[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsiArray[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsiArray;
};

function calculateAO(highs, lows) {
  const medians = [];
  for (let i = 0; i < highs.length; i++) {
    medians.push((highs[i] + lows[i]) / 2);
  }
  
  const sma5 = sma(medians, 5);
  const sma34 = sma(medians, 34);
  
  const ao = [];
  for (let i = 0; i < medians.length; i++) {
    if (sma5[i] === null || sma34[i] === null) {
      ao.push(null);
    } else {
      ao.push(sma5[i] - sma34[i]);
    }
  }
  return ao;
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEma[i] == null || slowEma[i] == null) {
      macdLine.push(null);
    } else {
      macdLine.push(fastEma[i] - slowEma[i]);
    }
  }
  
  const validMacd = macdLine.filter(m => m !== null);
  const signalEmaValid = ema(validMacd, signal);
  
  const signalLine = new Array(closes.length).fill(null);
  let j = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && j < signalEmaValid.length) {
      signalLine[i] = signalEmaValid[j];
      j++;
    }
  }
  
  return { macdLine, signalLine };
}

function evaluateCustomOptionsStrategy(candles, currentActiveTrade = null) {
  if (candles.length < 35) return { signal: null }; // need enough for AO SMA34

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ao = calculateAO(highs, lows);
  const { macdLine, signalLine } = calculateMACD(closes);
  const rsiArray = rsi(closes, 14);
  const sma18 = sma(closes, 18);

  const lastIndex = candles.length - 1;
  const currentAO = ao[lastIndex];
  const prevAO = ao[lastIndex - 1];
  const currentMacdLine = macdLine[lastIndex];
  const currentMacdSignal = signalLine[lastIndex];
  const currentRSI = rsiArray[lastIndex];
  const currentSMA18 = sma18[lastIndex];
  const prevSMA18 = sma18[lastIndex - 1];
  
  const ltp = closes[lastIndex];

  // Helper to check the 4 conditions
  const isAOPositive = currentAO > 0;
  const isMACDBullish = currentMacdLine > currentMacdSignal;
  const isRSIBullish = currentRSI > 45;
  const isSMA18Rising = currentSMA18 > prevSMA18;
  
  const conditions = [isAOPositive, isMACDBullish, isRSIBullish, isSMA18Rising];
  const conditionsMetCount = conditions.filter(c => c).length;
  const allConditionsMet = conditionsMetCount === 4;

  const indicators = {
    ao: currentAO,
    macdLine: currentMacdLine,
    macdSignal: currentMacdSignal,
    rsi: currentRSI,
    sma18: currentSMA18,
    sma18_prev: prevSMA18
  };

  // Exit Logic
  if (currentActiveTrade) {
    // 25 point SL
    if (ltp <= currentActiveTrade.entryPrice - 25) {
      return { signal: "SL_HIT", ...indicators, ltp };
    }
    // 2 out of 4 conditions must be FALSE simultaneously (which means conditionsMetCount <= 2)
    if (conditionsMetCount <= 2) {
      return { signal: "CONFLUENCE_BREAK", ...indicators, ltp };
    }
    // If no exit triggered, remain ACTIVE
    return { signal: "ACTIVE", ...indicators, ltp };
  }

  // Entry Logic
  if (allConditionsMet) {
    // Also ensuring AO just became positive is good, but user said "AO becomes positive". 
    // We can strictly check `currentAO > 0 && prevAO <= 0` but for confluence, normally it's just "is positive".
    // "awesome oscilator become positive" -> let's enforce prevAO <= 0
    if (prevAO <= 0) {
      return { signal: "BUY", ...indicators, ltp };
    }
  }

  return { signal: null };
}

module.exports = {
  evaluateCustomOptionsStrategy,
  calculateAO,
  calculateMACD,
  rsi,
  sma,
  ema
};
