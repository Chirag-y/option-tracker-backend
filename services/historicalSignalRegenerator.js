/**
 * Regenerate F&O and Swing scanner signals from Mongo candle data.
 * Uses actual candle timestamps — not Date.now().
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { calculateSwingTracker } = require("./swingTracker");
const { calculateMomentumTrackerV10 } = require("./momentumTracker");
const dailyCandleStore = require("./dailyCandleStore");
const intradayCandleStore = require("./intradayCandleStore");
const FoActiveTrade = require("../models/FoActiveTrade");
const SwingCandidate = require("../models/SwingCandidate");
const IntradayCandle = require("../models/IntradayCandle");
const FO_UNIVERSE = require("../config/foUniverse");
const { _internal: { istStartOfDay } } = require("./swingCandidateStore");
const { getIstHm, computeFoPnlPct, closeFoTradeRecord, dedupeFoTradesBySymbol } = require("./foTradeUtils");

const NSE_EQ_PATH = require("path").join(__dirname, "../config/nseEqUniverse.json");
let _nseEqUniverse = null;

function loadNseEqUniverse() {
  if (_nseEqUniverse) return _nseEqUniverse;
  try {
    _nseEqUniverse = require(NSE_EQ_PATH);
  } catch {
    _nseEqUniverse = FO_UNIVERSE;
  }
  return _nseEqUniverse;
}

function formatSignalTime(dateInput) {
  if (!dateInput) return null;
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return String(dateInput);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function tradingDaysAgo(days, fromDate = new Date()) {
  const out = istStartOfDay(fromDate);
  let remaining = days;
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() - 1);
    const dow = new Date(out.getTime() + 5.5 * 60 * 60 * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return out;
}

function dateOnlyStr(d) {
  return dailyCandleStore.getIstTradingDate(d);
}

function isWithinLastTradingDays(dateInput, days, asOf = new Date()) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return false;
  return d >= tradingDaysAgo(days, asOf);
}

function getLatestDataDate(candles) {
  if (!candles?.length) return null;
  const d = candles[candles.length - 1].date;
  return String(d).split("T")[0];
}

/** Most recent date with broad market coverage (avoids IST/UTC mismatch). */
async function getLatestMarketDateFromMongo() {
  try {
    const DailyCandle = require("../models/DailyCandle");
    const rows = await DailyCandle.aggregate([
      { $group: { _id: "$date", count: { $sum: 1 } } },
      { $match: { count: { $gte: 100 } } },
      { $sort: { _id: -1 } },
      { $limit: 1 },
    ]);
    if (rows[0]?._id) return rows[0]._id;
  } catch { /* fall through */ }
  return dailyCandleStore.getIstTradingDate();
}

/** Load FIVE_MINUTE intraday per symbol (indexed queries — avoids Mongo sort memory limit). */
async function loadFoIntradayBulk(symbols) {
  const map = {};
  const BATCH = 25;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    await Promise.all(batch.map(async (sym) => {
      const candles = await intradayCandleStore.loadHistoricalIntradayCandles(sym, "FIVE_MINUTE", 2500);
      if (candles?.length) map[sym] = candles;
    }));
    if (i % 50 === 0) {
      console.log(`[HistoricalRegen] Intraday load progress: ${Math.min(i + BATCH, symbols.length)}/${symbols.length}`);
    }
  }
  return map;
}

/**
 * Scan Mongo daily candles for swing signals over the past N trading days.
 */
async function regenerateSwingSignalsFromMongo({ days = 7, dailyCandlesRam = null } = {}) {
  const universe = loadNseEqUniverse();
  const allDaily = dailyCandlesRam && Object.keys(dailyCandlesRam).length > 0
    ? dailyCandlesRam
    : await dailyCandleStore.loadSymbols(loadNseEqUniverse().map(s => s.symbol));

  const niftyDaily = allDaily["Nifty 50"] || [];
  const latestIndexDate = await getLatestMarketDateFromMongo();

  let totalSignals = 0;
  let symbolsProcessed = 0;
  const dashboardSignals = [];
  const bulkOps = [];

  for (const stock of universe) {
    const candles = allDaily[stock.symbol];
    if (!candles || candles.length < 10) continue;

    symbolsProcessed++;
    const trackerRes = calculateSwingTracker(candles);
    const signalsInWindow = (trackerRes.signals || []).filter(s =>
      isWithinLastTradingDays(s.date, days)
    );

    for (const sig of signalsInWindow) {
      const direction = sig.action === "BUY" ? "BULLISH" : "BEARISH";
      const triggerDate = istStartOfDay(new Date(sig.date));
      bulkOps.push({
        updateOne: {
          filter: { symbol: stock.symbol, scannerId: "swing-tracker", triggerDate },
          update: {
            $set: {
              name: stock.name || stock.symbol,
              direction,
              triggerPrice: Number(sig.price || 0),
              strengthScore: Number(trackerRes.summary?.winRate || 50),
              isFO: !!stock.isFO,
              sector: stock.sector || "Other",
              raw: { ...sig, scannerId: "swing-tracker" },
            },
          },
          upsert: true,
        },
      });
      totalSignals++;

      if (String(sig.date).split("T")[0] === latestIndexDate) {
        dashboardSignals.push({
          symbol: stock.symbol,
          name: stock.name || stock.symbol,
          price: sig.price,
          change: 0,
          changePercent: 0,
          direction,
          strengthScore: Number(trackerRes.summary?.winRate || 50),
          triggerTime: formatSignalTime(sig.date),
          timestamp: formatSignalTime(sig.date),
          triggerPrice: sig.price,
          scannerName: "Swing Tracker",
          scannerId: "swing-tracker",
          signal: sig.action,
          ribbonBullishCount: sig.ribbonBullishCount || 0,
          sector: stock.sector || "Other",
          isFO: !!stock.isFO,
        });
      }
    }
  }

  if (bulkOps.length > 0) {
    for (let i = 0; i < bulkOps.length; i += 500) {
      await SwingCandidate.bulkWrite(bulkOps.slice(i, i + 500), { ordered: false });
    }
  }

  dashboardSignals.sort((a, b) => b.strengthScore - a.strengthScore);
  console.log(`[HistoricalRegen] Swing: ${symbolsProcessed} symbols, ${totalSignals} signals (${days}d), dashboard=${dashboardSignals.length} for ${latestIndexDate}`);

  return { totalSignals, symbolsProcessed, dashboardSignals, latestTradingDate: latestIndexDate };
}

function resolveIntradayFiveMinute(intradayMap, symbol) {
  const raw = intradayMap[symbol] || intradayMap[`${symbol}-EQ`];
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.FIVE_MINUTE)) return raw.FIVE_MINUTE;
  if (Array.isArray(raw["FIVE_MINUTE"])) return raw["FIVE_MINUTE"];
  return null;
}

/**
 * Replay F&O momentum signals from Mongo 5-min intraday candles.
 */
const FO_HISTORICAL_DAYS = 3;

async function regenerateFoSignalsFromMongo({ days = FO_HISTORICAL_DAYS, scannerIds = ["fo-bullish", "fo-bearish"], intradayRam = null } = {}) {
  const cutoff = tradingDaysAgo(days);
  await FoActiveTrade.deleteMany({
    scannerId: { $in: scannerIds },
    triggeredAt: { $gte: cutoff },
  });

  const stocks = FO_UNIVERSE.filter(s => s.symbol && !String(s.symbol).includes("ETF"));
  const symbols = stocks.map(s => s.symbol);
  const intradayMap = intradayRam && Object.keys(intradayRam).length > 0
    ? intradayRam
    : await loadFoIntradayBulk(symbols);

  console.log(`[HistoricalRegen] FO replay starting — single momentum pass per symbol (${stocks.length} stocks)...`);

  let totalSignals = 0;
  let stocksProcessed = 0;
  const dashboardByScanner = {};
  const allTradesToInsert = [];
  for (const id of scannerIds) dashboardByScanner[id] = {};

  const latestDate = await getLatestMarketDateFromMongo();

  for (const stock of stocks) {
    const intradayCandles = resolveIntradayFiveMinute(intradayMap, stock.symbol);
    if (!intradayCandles || intradayCandles.length < 50) continue;

    stocksProcessed++;
    if (stocksProcessed % 25 === 0) {
      console.log(`[HistoricalRegen] FO replay: ${stocksProcessed}/${stocks.length} (${stock.symbol})`);
    }

    const activeTrades = {};
    const stockTrades = [];

    // ONE momentum calculation per symbol (was O(n²) — recalculated on every bar slice)
    const momResults = calculateMomentumTrackerV10(intradayCandles);

    for (let j = 0; j < momResults.length; j++) {
      const lastMom = momResults[j];
      if (lastMom.signal !== "LONG" && lastMom.signal !== "SHORT") continue;

      const candle = intradayCandles[j];
      if (!candle) continue;
      const dt = new Date(candle.date);
      if (dt < cutoff) continue;

      const { h: istH, m: istM } = getIstHm(dt);
      const isEod = istH > 15 || (istH === 15 && istM >= 25);

      for (const key of Object.keys(activeTrades)) {
        if (isEod) {
          closeFoTradeRecord(activeTrades[key], candle.close, dt);
          delete activeTrades[key];
        }
      }

      if (istH === 9 && istM < 25) continue;
      if (istH === 15 && istM >= 20) continue;

      const direction = lastMom.signal === "LONG" ? "BULLISH" : "BEARISH";
      const scannerId = direction === "BULLISH" ? "fo-bullish" : "fo-bearish";
      if (!scannerIds.includes(scannerId)) continue;

      const oppId = direction === "BULLISH" ? "fo-bearish" : "fo-bullish";
      if (activeTrades[oppId]) {
        closeFoTradeRecord(activeTrades[oppId], candle.close, dt);
        delete activeTrades[oppId];
      }

      if (activeTrades[scannerId]) continue;

      const tr = {
        symbol: stock.symbol,
        direction,
        scannerId,
        entryPrice: candle.close,
        status: isEod ? "CLOSED" : "ACTIVE",
        triggeredAt: dt,
        closedAt: isEod ? dt : undefined,
        exitPrice: isEod ? candle.close : undefined,
        reasons: ["Momentum Tracker V10 (historical regen)"],
        strengthScore: 65,
      };
      if (isEod) {
        tr.pnlPct = computeFoPnlPct(direction, tr.entryPrice, tr.exitPrice);
      }
      stockTrades.push(tr);
      activeTrades[scannerId] = tr;
      totalSignals++;

      const dayStr = dateOnlyStr(dt);
      if (!dashboardByScanner[scannerId][dayStr]) dashboardByScanner[scannerId][dayStr] = {};
      dashboardByScanner[scannerId][dayStr][stock.symbol] = {
        symbol: stock.symbol,
        name: stock.name || stock.symbol,
        price: candle.close,
        change: 0,
        direction,
        strengthScore: 65,
        triggerTime: formatSignalTime(dt),
        timestamp: formatSignalTime(dt),
        triggerPrice: candle.close,
        scannerId,
        sector: stock.sector || "Other",
        isFO: true,
      };
    }
    allTradesToInsert.push(...stockTrades);
  }

  // Only the latest trading day may keep ACTIVE rows; auto-close stale open trades.
  for (const tr of allTradesToInsert) {
    if (tr.status === "ACTIVE" && dateOnlyStr(tr.triggeredAt) !== latestDate) {
      closeFoTradeRecord(tr, tr.entryPrice, tr.triggeredAt);
    }
  }

  const dedupedTrades = dedupeFoTradesBySymbol(allTradesToInsert);

  console.log(`[HistoricalRegen] FO replay done: ${stocksProcessed} symbols, ${totalSignals} trades`);

  if (dedupedTrades.length > 0) {
    for (let i = 0; i < dedupedTrades.length; i += 500) {
      await FoActiveTrade.insertMany(dedupedTrades.slice(i, i + 500), { ordered: false });
    }
  }

  const dashboardSignals = {};
  for (const id of scannerIds) {
    const byDay = dashboardByScanner[id];
    const dates = Object.keys(byDay).sort();
    const pickDate = dates.includes(latestDate) ? latestDate : dates[dates.length - 1];
    dashboardSignals[id] = Object.values(byDay[pickDate] || {})
      .sort((a, b) => b.strengthScore - a.strengthScore);
  }

  console.log(`[HistoricalRegen] FO: ${totalSignals} trades regenerated (${days}d)`);
  return { totalSignals, dashboardSignals };
}

async function runCli() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[HistoricalRegen] Connected to MongoDB");
  const swing = await regenerateSwingSignalsFromMongo({ days: 7 });
  const fo = await regenerateFoSignalsFromMongo({ days: FO_HISTORICAL_DAYS });
  console.log("[HistoricalRegen] Done.", { swing: swing.totalSignals, fo: fo.totalSignals });
  await mongoose.disconnect();
  process.exit(0);
}

module.exports = {
  FO_HISTORICAL_DAYS,
  regenerateSwingSignalsFromMongo,
  regenerateFoSignalsFromMongo,
  formatSignalTime,
  getLatestMarketDateFromMongo,
  tradingDaysAgo,
  runCli,
};
