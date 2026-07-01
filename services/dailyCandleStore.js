/**
 * dailyCandleStore.js — Phase 1
 * ------------------------------
 * MongoDB-backed source of truth for daily candles.
 *
 *   loadSeries(symbol)              -> Array<candle> (ascending date, capped at 500 newest)
 *   loadAll()                       -> { [symbol]: Array<candle> }
 *   upsertCandles(symbol, candles)  -> bulkWrite upsert on (symbol,date)
 *   getLastCandleDate(symbol)       -> "YYYY-MM-DD" | null
 *   hasFreshData(symbol, istDate)   -> boolean
 *
 *   getEodScanState(istDate)        -> { date, completedAt, ... } | null
 *   markEodScanStarted(istDate)
 *   markEodScanComplete(istDate, { symbolsFetched, symbolsSkipped, triggers })
 *
 *   getIstTradingDate()             -> "YYYY-MM-DD" in IST (Asia/Kolkata)
 *
 * All methods are defensive: if Mongo is offline or queries fail they log and
 * return safe defaults (empty array / null / false) so the caller can fall
 * back to the legacy JSON/RAM cache without crashing.
 */
const DailyCandle = require("../models/DailyCandle");
const EodScanState = require("../models/EodScanState");
const mongoose = require("mongoose");

const MAX_CANDLES_PER_SYMBOL = 500;

function mongoReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

/** Returns "YYYY-MM-DD" in IST (Asia/Kolkata). */
function getIstTradingDate(date = new Date()) {
  // en-CA produces "YYYY-MM-DD" with no locale-specific separators.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function loadSeries(symbol) {
  if (!mongoReady()) return [];
  try {
    const docs = await DailyCandle.find({ symbol })
      .sort({ date: -1 })
      .limit(MAX_CANDLES_PER_SYMBOL)
      .select("date open high low close volume -_id")
      .lean();
    return docs.reverse().map(d => ({
      date: d.date,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume,
    }));
  } catch (err) {
    console.error(`[DailyCandleStore] loadSeries(${symbol}) failed:`, err.message);
    return [];
  }
}

/** Bulk-load all daily candles into an in-memory map keyed by symbol. */
async function loadAll() {
  const result = {};
  if (!mongoReady()) return result;
  try {
    const docs = await DailyCandle.find({}).sort({ symbol: 1, date: -1 }).lean();
    
    for (const d of docs) {
      if (!result[d.symbol]) {
        result[d.symbol] = [];
      }
      if (result[d.symbol].length < MAX_CANDLES_PER_SYMBOL) {
        result[d.symbol].push({
          date: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume,
        });
      }
    }
    
    // Reverse them to be ascending date like before
    for (const sym of Object.keys(result)) {
      result[sym].reverse();
    }
    return result;
  } catch (err) {
    console.error("[DailyCandleStore] loadAll failed:", err.message);
    return result;
  }
}

async function upsertCandles(symbol, candles) {
  if (!mongoReady() || !Array.isArray(candles) || candles.length === 0) return 0;
  try {
    const ops = candles
      .filter(c => c && c.date && Number.isFinite(c.close))
      .map(c => ({
        updateOne: {
          filter: { symbol, date: c.date },
          update: {
            $set: {
              symbol,
              date:   c.date,
              open:   Number(c.open),
              high:   Number(c.high),
              low:    Number(c.low),
              close:  Number(c.close),
              volume: Number(c.volume) || 0,
            },
          },
          upsert: true,
        },
      }));
    if (ops.length === 0) return 0;
    const res = await DailyCandle.bulkWrite(ops, { ordered: false });
    return (res.upsertedCount || 0) + (res.modifiedCount || 0);
  } catch (err) {
    console.error(`[DailyCandleStore] upsertCandles(${symbol}) failed:`, err.message);
    return 0;
  }
}

async function getLastCandleDate(symbol) {
  if (!mongoReady()) return null;
  try {
    const doc = await DailyCandle.findOne({ symbol })
      .sort({ date: -1 })
      .select("date -_id")
      .lean();
    return doc ? doc.date : null;
  } catch (err) {
    console.error(`[DailyCandleStore] getLastCandleDate(${symbol}) failed:`, err.message);
    return null;
  }
}

async function hasFreshData(symbol, istDate = getIstTradingDate()) {
  const last = await getLastCandleDate(symbol);
  return last === istDate;
}

// ---- EOD scan state ----

async function getEodScanState(istDate = getIstTradingDate()) {
  if (!mongoReady()) return null;
  try {
    return await EodScanState.findOne({ date: istDate }).lean();
  } catch (err) {
    console.error("[DailyCandleStore] getEodScanState failed:", err.message);
    return null;
  }
}

async function markEodScanStarted(istDate = getIstTradingDate()) {
  if (!mongoReady()) return null;
  try {
    return await EodScanState.findOneAndUpdate(
      { date: istDate },
      { $setOnInsert: { date: istDate, startedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error("[DailyCandleStore] markEodScanStarted failed:", err.message);
    return null;
  }
}

async function markEodScanComplete(istDate, stats = {}) {
  if (!mongoReady()) return null;
  try {
    return await EodScanState.findOneAndUpdate(
      { date: istDate },
      {
        $set: {
          completedAt:    new Date(),
          symbolsFetched: stats.symbolsFetched || 0,
          symbolsSkipped: stats.symbolsSkipped || 0,
          triggers:       stats.triggers || 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error("[DailyCandleStore] markEodScanComplete failed:", err.message);
    return null;
  }
}

async function isEodScanCompleteForToday() {
  const state = await getEodScanState();
  return Boolean(state && state.completedAt);
}

module.exports = {
  loadSeries,
  loadAll,
  upsertCandles,
  getLastCandleDate,
  hasFreshData,
  getEodScanState,
  markEodScanStarted,
  markEodScanComplete,
  isEodScanCompleteForToday,
  getIstTradingDate,
};
