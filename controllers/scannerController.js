const { calculateHullSignals } = require("../services/hullScanner");
const { calculateSwingTracker } = require("../services/swingTracker");
const { runBacktest } = require("../services/backtestEngine");
const { resolveIndexAlias } = require("../config/indexSymbolMap");

/**
 * Endpoint to fetch historical backtesting data for a specific scanner.
 * Route: GET /api/scanner/:id/backtest?period=60
 */
const backtestCache = {};

exports.getBacktest = async (req, res) => {
  try {
    const { id } = req.params;
    const period = parseInt(req.query.period) || 60;
    
    const cacheKey = `${id}_${period}`;
    if (backtestCache[cacheKey] && (Date.now() - backtestCache[cacheKey].timestamp < 5 * 60 * 1000)) {
      return res.json(backtestCache[cacheKey].data);
    }

    const isFoScanner = ["fo-bullish", "fo-bearish", "options-bullish", "options-bearish"].includes(id);

    if (isFoScanner) {
      const FoActiveTrade = require("../models/FoActiveTrade");
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - period);

      const scannerIds = [id];

      const trades = await FoActiveTrade.find({
        scannerId: { $in: scannerIds },
        triggeredAt: { $gte: cutoffDate }
      }).sort({ triggeredAt: -1 }).lean();

      let winningTrades = 0;
      let losingTrades = 0;
      let totalProfitPct = 0;

      const mappedTrades = trades.map((t, idx) => {
        let isProfit = false; 
        if (t.status === "CLOSED") {
          isProfit = t.pnlPct > 0; 
          if (isProfit) winningTrades++;
          else losingTrades++;
          totalProfitPct += (t.pnlPct || 0);
        }

        return {
          id: `fo_${id}_${t._id || idx}`,
          symbol: t.symbol,
          name: t.symbol,
          type: t.direction === "BULLISH" || t.direction === "CALL" ? "BUY" : "SELL",
          entryDate: t.triggeredAt ? new Date(t.triggeredAt).toISOString() : (t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString()),
          entryPrice: t.entryPrice,
          exitDate: t.closedAt ? new Date(t.closedAt).toISOString() : null,
          exitPrice: t.exitPrice || null,
          status: t.status === "CLOSED" ? (isProfit ? "PROFIT" : "LOSS") : "OPEN",
          pnlPct: t.pnlPct || 0,
          signalStrength: (t.strengthScore >= 70 ? "STRONG" : (t.strengthScore >= 50 ? "MEDIUM" : "WEAK")) + (t.strengthScore ? ` (${t.strengthScore})` : ""),
          reason: t.reasons ? t.reasons.join(", ") : "Momentum",
          isRisky: false
        };
      });

      const responseData = {
        success: true,
        stats: {
          totalTrades: mappedTrades.length,
          winningTrades,
          losingTrades,
          winRate: mappedTrades.length > 0 ? Math.round((winningTrades / (winningTrades + losingTrades)) * 100) : 100,
          averageProfitPct: winningTrades + losingTrades > 0 ? Number((totalProfitPct / (winningTrades + losingTrades)).toFixed(2)) : 0,
          netProfitPct: Number(totalProfitPct.toFixed(2))
        },
        trades: mappedTrades,
        equityCurve: []
      };
      
      backtestCache[cacheKey] = {
        timestamp: Date.now(),
        data: responseData
      };
      
      return res.json(responseData);
    }

    const result = await runBacktest(id, period);
    const responseData = {
      success: true,
      ...result
    };
    
    backtestCache[cacheKey] = {
      timestamp: Date.now(),
      data: responseData
    };
    
    return res.json(responseData);
  } catch (err) {
    console.error(`[getBacktest] Error for ${req.params.id}:`, err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

exports.scanStock = async (req, res) => {
  try {
    const { candles } = req.body;
    if (!candles || !Array.isArray(candles)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing candles array in request body."
      });
    }

    const signals = calculateHullSignals(candles);
    return res.json({
      success: true,
      signals
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

/**
 * Endpoint to compute Swing Tracker signals and simulator stats for a stock.
 * Body: { candles: Array, options: Object }
 */
exports.scanSwingTracker = async (req, res) => {
  try {
    const { candles, options } = req.body;
    if (!candles || !Array.isArray(candles)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing candles array in request body."
      });
    }

    const result = calculateSwingTracker(candles, options || {});
    return res.json({
      success: true,
      ...result
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};
const { forceRecalculateScanner, runEodSwingScan, getHistoricalDailyCandles, getStockIndicators, getNseEqUniverse, computeStockMetrics, calculateStrengthScore, fetchHistoricalDailyCandles, getSymbolToTokenMap } = require("../services/scannerEngine");

/**
 * Endpoint to trigger manual recalculation of a specific swing scanner.
 * Route: POST /api/scanner/:id/recalculate
 */
exports.recalculateScanner = async (req, res) => {
  try {
    const { id } = req.params;
    const allowedScanners = ["swing-tracker", "fo-bullish", "fo-bearish"];
    if (!allowedScanners.includes(id)) {
      return res.status(400).json({
        success: false,
        message: `Recalculation is only supported for: ${allowedScanners.join(", ")}`
      });
    }

    // Swing tracker uses the full EOD scan (fetches candles for all 1600+ NSE EQ stocks)
    if (id === "swing-tracker") {
      // Run async — this can take several minutes for 1600+ stocks
      runEodSwingScan().catch(err => console.error("[ScannerController] EOD swing scan error:", err.message));
      return res.json({
        success: true,
        message: "Swing Tracker EOD scan started. Results will appear on the dashboard as they are computed."
      });
    }

    const signals = await forceRecalculateScanner(id);
    return res.json({
      success: true,
      message: `Scanner ${id} successfully recalculated.`,
      signals
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

/**
 * Phase 0.5 / Phase 3.4: Map frontend index aliases to the scrip-master /
 * candle-cache keys used throughout scannerEngine via the central registry in
 * config/indexSymbolMap.js.
 */

/**
 * Endpoint to fetch live metrics, historical candles, and technical indicators for a specific stock.
 * Route: GET /api/scanner/stock/:symbol
 */
exports.getStockDetails = async (req, res) => {
  try {
    const rawSymbol = (req.params.symbol || "").trim();
    if (!rawSymbol) {
      return res.status(400).json({ success: false, message: "Missing stock symbol parameter." });
    }

    // For indices, the candle-cache and scrip-master both key off the human-readable
    // name ("Nifty 50"), not the UI alias (NIFTY). Resolve before any lookups.
    const aliasedIndex = resolveIndexAlias(rawSymbol);
    const symbol = aliasedIndex || rawSymbol.toUpperCase();
    const isIndex = Boolean(aliasedIndex);

    const universe = getNseEqUniverse() || [];
    const stockInfo = universe.find(s => s.symbol === symbol);

    const allCandles = getHistoricalDailyCandles() || {};
    let stockCandles = allCandles[symbol];
    const niftyCandles = allCandles["Nifty 50"] || [];

    // If candles are not in local cache, dynamically fetch from SmartAPI
    if (!stockCandles || stockCandles.length === 0) {
      console.log(`[ScannerController] Candles not in cache for ${symbol}, attempting dynamic fetch...`);
      const symbolToTokenMap = getSymbolToTokenMap();
      // For indices the scrip-master key is the canonical name itself; for equities try -EQ then bare.
      const instrument = isIndex
        ? (symbolToTokenMap[symbol] || symbolToTokenMap[rawSymbol.toUpperCase()])
        : (symbolToTokenMap[`${symbol}-EQ`] || symbolToTokenMap[symbol]);

      if (!instrument) {
        return res.status(404).json({
          success: false,
          message: `No token mapping found for symbol ${rawSymbol}. Please ensure the stock exists on NSE.`
        });
      }

      const fetched = await fetchHistoricalDailyCandles(symbol, instrument.token, instrument.segment);
      if (!fetched) {
        return res.status(404).json({
          success: false,
          message: `Unable to fetch historical candles for ${rawSymbol}. Please try again later.`
        });
      }

      // Re-read from cache after fetching
      stockCandles = getHistoricalDailyCandles()[symbol];
    }

    if (!stockCandles || stockCandles.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No candles found for symbol ${symbol}.`
      });
    }

    const ind = getStockIndicators(stockCandles);

    const name = stockInfo?.name || `${symbol} Industries Ltd.`;
    const sector = stockInfo?.sector || "Industrial Sector";
    const ltp = stockInfo?.price || stockCandles[stockCandles.length - 1].close;
    const change = stockInfo?.changePercent || 0;
    const isFO = stockInfo?.isFO || false;

    const peRatio = 15 + (symbol.charCodeAt(0) % 20);
    const volume = stockCandles[stockCandles.length - 1].volume || 100000;
    const avgVol10 = ind.avgVol10 || 100000;
    const avgVol20 = ind.avgVol20 || 100000;
    const deliveryPercent = 50 + (symbol.charCodeAt(0) % 25);
    const high52W = ind.maxHigh || ltp * 1.15;
    const low52W = ind.minLow || ltp * 0.82;

    const metrics = computeStockMetrics(symbol, stockCandles, niftyCandles);
    let strengthResult = { score: 50, breakdown: { trend: 0, momentum: 0, volume: 0, relativeStrength: 0, breakout: 0, bonus: 0 } };
    if (metrics) {
      strengthResult = calculateStrengthScore(metrics);
    }

    return res.json({
      success: true,
      symbol,
      name,
      sector,
      price: ltp,
      change,
      isFO,
      peRatio,
      volume,
      avgVol10d: Math.round(avgVol10),
      avgVol20d: Math.round(avgVol20),
      deliveryPercent: `${deliveryPercent.toFixed(1)}%`,
      high52W,
      low52W,
      metrics,
      strength: strengthResult,
      candles: stockCandles.map(c => ({
        time: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 100000
      })),
      indicators: {
        rsi: ind.currentRsi,
        ema9: ind.currentEma9,
        ema20: ind.currentEma20,
        ema50: ind.currentEma50,
        ema200: ind.currentEma200
      }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

const { getCommodityUniverse, getTickCache } = require("../services/marketDataFeed");
const { getActiveCommodityUniverse } = require("../services/commodityContractManager");

/**
 * Endpoint to fetch live commodity prices from the MCX universe.
 * Route: GET /api/scanner/commodities
 *
 * Phase 0.2: prefer the Mongo-backed CommodityContractManager universe
 * (the authoritative source used by LiveUniverseManager + WebSocket feed).
 * Falls back to the legacy in-memory universe from marketDataFeed if Mongo
 * is empty (e.g. fresh boot before syncCommodityContracts has completed).
 */
exports.getCommodities = async (req, res) => {
  try {
    let universe = [];
    try {
      universe = (await getActiveCommodityUniverse()) || [];
    } catch (e) {
      console.warn("[ScannerController] getActiveCommodityUniverse failed, falling back:", e.message);
    }
    if (!universe || universe.length === 0) {
      universe = getCommodityUniverse() || [];
    }
    const ticks = getTickCache() || {};

    const commoditiesData = universe.map(item => {
      // Phase 4.2: look up live tick by exact contract symbol first, then by base commodity name
      const tick = ticks[item.symbol] || ticks[item.commodity] || {};
      return {
        commodity: item.commodity,
        symbol: item.symbol,
        token: item.token,
        segment: item.segment,
        expiry: item.expiry,
        price: tick.price || tick.ltp || null,
        changePercent: tick.changePercent !== undefined ? tick.changePercent : null,
        timestamp: tick.timestamp || null
      };
    });

    return res.json({
      success: true,
      commodities: commoditiesData
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

const FoActiveTrade = require("../models/FoActiveTrade");

exports.getFoActiveTrades = async (req, res) => {
  try {
    const trades = await FoActiveTrade.find().sort({ createdAt: -1 }).limit(100);
    return res.json({ success: true, trades });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
const IntradayCandle = require("../models/IntradayCandle");
const DailyCandle = require("../models/DailyCandle");
const fs = require("fs");
const path = require("path");
const { getSmartApiInstance } = require("../services/smartApiSession");
const intradayCandleStore = require("../services/intradayCandleStore");

// Helper to format date in Indian Timezone

exports.getDataStatus = async (req, res) => {
  try {
    const fnoUniversePath = path.join(__dirname, '../config/scripMaster.json');
    let fnoData = [];
    if (fs.existsSync(fnoUniversePath)) {
      fnoData = JSON.parse(fs.readFileSync(fnoUniversePath, 'utf8'));
    }
    const fnoSymbols = fnoData
      .filter(s => s.instrumenttype === "OPTSTK" || s.instrumenttype === "FUTSTK" || s.exch_seg === "NSE")
      .map(s => s.name);
    const uniqueSymbols = [...new Set(fnoSymbols)];

    const intradayAgg = await IntradayCandle.aggregate([
      { $match: { symbol: { $in: uniqueSymbols } } },
      { $group: {
          _id: { symbol: "$symbol", interval: "$interval" },
          minDate: { $min: "$date" },
          maxDate: { $max: "$date" },
          count: { $sum: 1 }
        }
      }
    ]);

    const dailyAgg = await DailyCandle.aggregate([
      { $match: { symbol: { $in: uniqueSymbols.map(s => s + "-EQ").concat(uniqueSymbols) } } },
      { $group: {
          _id: "$symbol",
          minDate: { $min: "$date" },
          maxDate: { $max: "$date" },
          count: { $sum: 1 }
        }
      }
    ]);

    const statusMap = {};
    uniqueSymbols.forEach(sym => {
      statusMap[sym] = {
        symbol: sym,
        m1: "Missing",
        m3: "Missing",
        m5: "Missing",
        daily: "Missing"
      };
    });

    intradayAgg.forEach(doc => {
      const sym = doc._id.symbol;
      const inv = doc._id.interval; // "ONE_MINUTE", "THREE_MINUTE", "FIVE_MINUTE"
      if (!statusMap[sym]) return;
      
      const rangeStr = `${formatToIndianTime(doc.minDate)} to ${formatToIndianTime(doc.maxDate)} (${doc.count})`;
      if (inv === "ONE_MINUTE" || inv === "1M") statusMap[sym].m1 = rangeStr;
      if (inv === "THREE_MINUTE" || inv === "3M") statusMap[sym].m3 = rangeStr;
      if (inv === "FIVE_MINUTE" || inv === "5M") statusMap[sym].m5 = rangeStr;
    });

    dailyAgg.forEach(doc => {
      const sym = doc._id.replace("-EQ", "");
      if (!statusMap[sym]) return;
      statusMap[sym].daily = `${doc.minDate.substring(0, 10)} to ${doc.maxDate.substring(0, 10)} (${doc.count})`;
    });

    res.json({ success: true, data: Object.values(statusMap) });
  } catch (error) {
    console.error("Data Status Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.fetchMissingData = async (req, res) => {
  const { symbol, interval = "FIVE_MINUTE", days = 7 } = req.body;
  if (!symbol) return res.status(400).json({ success: false, message: "Symbol required" });

  try {
    const fnoUniversePath = path.join(__dirname, '../config/scripMaster.json');
    const fnoData = JSON.parse(fs.readFileSync(fnoUniversePath, 'utf8'));
    const instrument = fnoData.find(s => s.name === symbol && s.exch_seg === "NSE");
    
    if (!instrument) {
      return res.status(404).json({ success: false, message: "Symbol not found in scripMaster as NSE equity" });
    }

    const api = getSmartApiInstance();
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - days);

    const formatAngelDate = (date, isEnd) => {
      return date.getFullYear() + "-" +
        String(date.getMonth() + 1).padStart(2, "0") + "-" +
        String(date.getDate()).padStart(2, "0") + (isEnd ? " 15:30" : " 09:15");
    };

    const reqBody = {
      exchange: "NSE",
      symboltoken: instrument.token,
      interval: interval,
      fromdate: formatAngelDate(fromDate, false),
      todate: formatAngelDate(toDate, true)
    };

    const result = await api.getCandleData(reqBody);
    if (result && result.status && result.data && result.data.length > 0) {
      const mapped = result.data.map(arr => ({
        date: new Date(arr[0]).toISOString(),
        open: arr[1],
        high: arr[2],
        low: arr[3],
        close: arr[4],
        volume: arr[5]
      }));
      await intradayCandleStore.saveHistoricalIntradayCandles(symbol, interval, mapped);
      return res.json({ success: true, message: `Saved ${mapped.length} candles to Mongo!` });
    } else {
      return res.status(400).json({ success: false, message: "Angel One API returned no data" });
    }
  } catch (error) {
    console.error("Fetch missing data error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
