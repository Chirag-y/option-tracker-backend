const IntradayCandle = require("../models/IntradayCandle");

async function saveHistoricalIntradayCandles(symbol, interval, candles) {
  if (!candles || candles.length === 0) return;
  const ops = candles.map((c) => ({
    updateOne: {
      filter: { symbol, interval, date: c.date },
      update: { $set: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } },
      upsert: true,
    },
  }));
  try {
    await IntradayCandle.bulkWrite(ops, { ordered: false });
  } catch (error) {
    if (error.code !== 11000) console.error(`[IntradayCandleStore] Failed to bulkWrite for ${symbol}:`, error.message);
  }
}

async function loadHistoricalIntradayCandles(symbol, interval, limit = 1500) {
  try {
    const docs = await IntradayCandle.find({ symbol, interval }).sort({ date: -1 }).limit(limit).lean();
    return docs.reverse().map((d) => ({
      date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
    }));
  } catch (error) {
    return [];
  }
}

async function getLatestIntradayCandleDate(symbol, interval) {
  try {
    const doc = await IntradayCandle.findOne({ symbol, interval }).sort({ date: -1 }).lean();
    return doc ? doc.date : null;
  } catch (error) {
    return null;
  }
}

module.exports = { saveHistoricalIntradayCandles, loadHistoricalIntradayCandles, getLatestIntradayCandleDate };
