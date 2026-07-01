/**
 * Shared Incremental Indicator Engine  (Phase 1, P0)
 * ==================================================
 * Single source of truth for EMA / ATR / RSI calculations across all scanners.
 * Eliminates the redundant per-bar O(N) recomputation that lives inside
 * swingTracker / hullScanner / momentumTracker / refinedIndexScanner today.
 *
 * Approach:
 *   - Keep a small state object per (symbol, timeframe, indicatorKey).
 *   - Each call passes the *latest* candle; we update state in O(1) and return the value.
 *   - For initial warm-up we accept a full series via `seed()`; thereafter scanners only push
 *     incremental candles via `update()`.
 *
 * Memory: ~40 bytes per indicator state. 300 symbols x 6 indicators x 3 timeframes ≈ 200 KB.
 */

const _state = new Map(); // key -> state object

function _key(symbol, timeframe, indicator, period) {
  return `${symbol}|${timeframe}|${indicator}|${period}`;
}

/* ---------- EMA ---------- */
function emaSeed(symbol, timeframe, period, values) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  _state.set(_key(symbol, timeframe, "ema", period), { ema, k, period });
  return ema;
}
function emaUpdate(symbol, timeframe, period, value) {
  const key = _key(symbol, timeframe, "ema", period);
  const s = _state.get(key);
  if (!s) {
    _state.set(key, { ema: value, k: 2 / (period + 1), period });
    return value;
  }
  s.ema = value * s.k + s.ema * (1 - s.k);
  return s.ema;
}
function emaGet(symbol, timeframe, period) {
  return _state.get(_key(symbol, timeframe, "ema", period))?.ema ?? null;
}

/* ---------- ATR (Wilder) ---------- */
function _trueRange(h, l, prevClose) {
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}
function atrSeed(symbol, timeframe, period, candles) {
  if (candles.length < period + 1) return null;
  let trSum = 0;
  for (let i = 1; i <= period; i++) trSum += _trueRange(candles[i].high, candles[i].low, candles[i - 1].close);
  let atr = trSum / period;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = _trueRange(candles[i].high, candles[i].low, candles[i - 1].close);
    atr = (atr * (period - 1) + tr) / period;
  }
  _state.set(_key(symbol, timeframe, "atr", period), { atr, period, lastClose: candles[candles.length - 1].close });
  return atr;
}
function atrUpdate(symbol, timeframe, period, candle) {
  const key = _key(symbol, timeframe, "atr", period);
  const s = _state.get(key);
  if (!s) {
    _state.set(key, { atr: candle.high - candle.low, period, lastClose: candle.close });
    return candle.high - candle.low;
  }
  const tr = _trueRange(candle.high, candle.low, s.lastClose);
  s.atr = (s.atr * (s.period - 1) + tr) / s.period;
  s.lastClose = candle.close;
  return s.atr;
}
function atrGet(symbol, timeframe, period) {
  return _state.get(_key(symbol, timeframe, "atr", period))?.atr ?? null;
}

/* ---------- RSI (Wilder) ---------- */
function rsiSeed(symbol, timeframe, period, closes) {
  if (closes.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gainSum += d; else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  _state.set(_key(symbol, timeframe, "rsi", period), {
    avgGain, avgLoss, period, lastClose: closes[closes.length - 1],
  });
  return _rsiFrom(avgGain, avgLoss);
}
function _rsiFrom(g, l) {
  if (l === 0) return 100;
  const rs = g / l;
  return 100 - 100 / (1 + rs);
}
function rsiUpdate(symbol, timeframe, period, close) {
  const key = _key(symbol, timeframe, "rsi", period);
  const s = _state.get(key);
  if (!s) {
    _state.set(key, { avgGain: 0, avgLoss: 0, period, lastClose: close });
    return 50;
  }
  const d = close - s.lastClose;
  const g = d > 0 ? d : 0;
  const l = d < 0 ? -d : 0;
  s.avgGain   = (s.avgGain * (s.period - 1) + g) / s.period;
  s.avgLoss   = (s.avgLoss * (s.period - 1) + l) / s.period;
  s.lastClose = close;
  return _rsiFrom(s.avgGain, s.avgLoss);
}
function rsiGet(symbol, timeframe, period) {
  const s = _state.get(_key(symbol, timeframe, "rsi", period));
  if (!s) return null;
  return _rsiFrom(s.avgGain, s.avgLoss);
}

/* ---------- Lifecycle ---------- */
function dropSymbol(symbol) {
  for (const key of _state.keys()) {
    if (key.startsWith(`${symbol}|`)) _state.delete(key);
  }
}
function dropAll() { _state.clear(); }
function size() { return _state.size; }

module.exports = {
  ema:  { seed: emaSeed,  update: emaUpdate, get: emaGet },
  atr:  { seed: atrSeed,  update: atrUpdate, get: atrGet },
  rsi:  { seed: rsiSeed,  update: rsiUpdate, get: rsiGet },
  dropSymbol, dropAll, size,
};
