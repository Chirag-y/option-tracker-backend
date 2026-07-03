const { calculateHullSignals } = require("../services/hullScanner");
const { calculateSwingTracker } = require("../services/swingTracker");
const { runBacktest } = require("../services/backtestEngine");
const { resolveIndexAlias } = require("../config/indexSymbolMap");

/**
 * Endpoint to fetch historical backtesting data for a specific scanner.
 * Route: GET /api/scanner/:id/backtest?period=60
 */
const backtestCache = {};

function clearBacktestCache(scannerId) {
  if (scannerId) {
    for (const key of Object.keys(backtestCache)) {
      if (key.startsWith(`${scannerId}_`)) delete backtestCache[key];
    }
    return;
  }
  for (const key of Object.keys(backtestCache)) delete backtestCache[key];
}

exports.clearBacktestCache = clearBacktestCache;

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
      const { computeFoPnlPct, dedupeFoTradesBySymbol } = require("../services/foTradeUtils");
      const { tradingDaysAgo } = require("../services/historicalSignalRegenerator");
      const cutoffDate = tradingDaysAgo(period);

      const scannerIds = [id];

      let trades = await FoActiveTrade.find({
        scannerId: { $in: scannerIds },
        triggeredAt: { $gte: cutoffDate }
      }).sort({ triggeredAt: -1 }).lean();

      trades = dedupeFoTradesBySymbol(trades);

      let winningTrades = 0;
      let losingTrades = 0;
      let totalProfitPct = 0;

      const mappedTrades = trades.map((t, idx) => {
        const isShort = t.direction === "BEARISH";
        let pnlPct = t.pnlPct;
        if (t.status === "CLOSED" && (pnlPct == null || pnlPct === 0) && t.exitPrice) {
          pnlPct = computeFoPnlPct(t.direction, t.entryPrice, t.exitPrice);
        }

        let isProfit = false;
        if (t.status === "CLOSED") {
          isProfit = (pnlPct ?? 0) > 0;
          if (isProfit) winningTrades++;
          else losingTrades++;
          totalProfitPct += (pnlPct || 0);
        }

        return {
          id: `fo_${id}_${t._id || idx}`,
          symbol: t.symbol,
          name: t.symbol,
          type: isShort ? "SELL" : "BUY",
          direction: t.direction,
          entryDate: t.triggeredAt ? new Date(t.triggeredAt).toISOString() : (t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString()),
          entryPrice: t.entryPrice,
          exitDate: t.closedAt ? new Date(t.closedAt).toISOString() : null,
          exitPrice: t.exitPrice || null,
          status: t.status === "CLOSED" ? (isProfit ? "PROFIT" : "LOSS") : "OPEN",
          pnlPct: pnlPct ?? 0,
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

    // Swing tracker — regenerate from Mongo daily candles (past 7 days), no API fetch
    if (id === "swing-tracker") {
      const { clearBacktestCache } = exports;
      forceRecalculateScanner("swing-tracker")
        .then(signals => {
          clearBacktestCache("swing-tracker");
          console.log(`[ScannerController] Swing regen complete: ${signals?.length ?? 0} signals`);
        })
        .catch(err => console.error("[ScannerController] Swing regen error:", err.message));
      return res.json({
        success: true,
        message: "Swing Tracker regeneration started from Mongo candles (past 7 days). Results will appear shortly.",
      });
    }

    const signals = await forceRecalculateScanner(id);
    exports.clearBacktestCache(id);
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

    const aliasedIndex = resolveIndexAlias(rawSymbol);
    const symbol = aliasedIndex || rawSymbol.toUpperCase();
    const isIndex = Boolean(aliasedIndex);

    const universe = getNseEqUniverse() || [];
    const stockInfo = universe.find(s => s.symbol === symbol);

    const allCandles = getHistoricalDailyCandles() || {};
    let stockCandles = allCandles[symbol];
    const niftyCandles = allCandles["Nifty 50"] || [];

    if (!stockCandles || stockCandles.length === 0) {
      console.log(`[ScannerController] Candles not in cache for ${symbol}, attempting dynamic fetch...`);
      const symbolToTokenMap = getSymbolToTokenMap();
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

      stockCandles = getHistoricalDailyCandles()[symbol];
      
      const CustomSwingStock = require("../models/CustomSwingStock");
      const scannerEngine = require("../services/scannerEngine");
      
      try {
        await CustomSwingStock.findOneAndUpdate(
          { symbol: symbol },
          { symbol: symbol },
          { upsert: true, setDefaultsOnInsert: true }
        );
        if (scannerEngine.dynamicallyAddSwingStock) {
          scannerEngine.dynamicallyAddSwingStock(symbol);
        }
      } catch (err) {
        console.error(`[ScannerController] Error dynamically tracking ${symbol}:`, err.message);
      }
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
      feedPaused: require("../services/commodityFeedControl").isCommodityFeedPaused(),
      commodities: commoditiesData
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

exports.getCommodityFeedStatus = (_req, res) => {
  try {
    const { getCommodityFeedStatus } = require("../services/commodityFeedControl");
    return res.json({ success: true, ...getCommodityFeedStatus() });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.setCommodityFeedPaused = async (req, res) => {
  try {
    const { setCommodityFeedPaused } = require("../services/commodityFeedControl");
    const result = await setCommodityFeedPaused(req.body?.paused === true);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
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
const formatToIndianTime = (isoString) => {
    if (!isoString) return "N/A";
    return new Date(isoString).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
};


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
      return res.status(400).json({ success: true, message: "Missing data fetch initiated in background." });
    }
  } catch (err) {
    console.error("[ScannerController] fetchMissingData error:", err);
    return res.status(500).json({ success: false, message: "Server error during data fetch" });
  }
};

exports.getCustomOptionsStrikes = async (req, res) => {
  try {
    const { getStrikesForIndex, resolveIndexName } = require("../services/customOptionsStrikeCatalog");
    const index = String(req.query.index || "nifty").toLowerCase();
    if (!resolveIndexName(index)) {
      return res.status(400).json({ success: false, message: "Invalid index. Use nifty, banknifty, or sensex." });
    }
    const expiry = req.query.expiry ? String(req.query.expiry) : null;
    const catalog = getStrikesForIndex(index, expiry);
    return res.json({ success: true, ...catalog });
  } catch (err) {
    console.error("[ScannerController] getCustomOptionsStrikes error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.fetchCustomOptionsHistorical = async (req, res) => {
  try {
    const { callStrike, putStrike } = req.body;
    if (!callStrike || !putStrike) {
      return res.status(400).json({ success: false, message: "Missing callStrike or putStrike" });
    }

    const user = _optionalAuth(req);
    if (user?.id) {
      try {
        const User = require("../models/User");
        await User.findByIdAndUpdate(user.id, {
          customOptionsCallStrike: callStrike,
          customOptionsPutStrike: putStrike,
        });
      } catch (err) {
        console.warn("[ScannerController] Failed to save custom options prefs:", err.message);
      }
    }

    const customOptionsEngine = require("../services/customOptionsEngine");
    if (customOptionsEngine.processCustomOptionsHistoricalData) {
      customOptionsEngine.processCustomOptionsHistoricalData(callStrike, putStrike)
        .then(summary => console.log("[ScannerController] Custom options job finished:", summary?.totalSaved ?? 0, "signals"))
        .catch(err => console.error("[ScannerController] custom options process error:", err.message));
    }

    res.json({
      success: true,
      message: "Fetching 3 days of history from broker (call + put, 1M + 3M). This usually takes 2–3 minutes.",
      callStrike,
      putStrike,
    });
  } catch (err) {
    console.error("[ScannerController] fetchCustomOptionsHistorical error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

function _optionalAuth(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const jwt = require("jsonwebtoken");
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return { id: payload.id, teamCode: payload.teamCode, email: payload.email };
  } catch {
    return null;
  }
}

exports.getCustomOptions = async (req, res) => {
  try {
    const CustomOptionsSignal = require("../models/CustomOptionsSignal");
    const User = require("../models/User");

    let query = {};
    const symbolsParam = req.query.symbols;
    if (symbolsParam) {
      const list = String(symbolsParam).split(",").map(s => s.trim()).filter(Boolean);
      if (list.length > 0) query = { symbol: { $in: list } };
    } else {
      const user = _optionalAuth(req);
      if (user?.id) {
        const profile = await User.findById(user.id)
          .select("customOptionsCallStrike customOptionsPutStrike")
          .lean();
        const strikes = [profile?.customOptionsCallStrike, profile?.customOptionsPutStrike].filter(Boolean);
        if (strikes.length > 0) query = { symbol: { $in: strikes } };
      }
    }

    const signals = await CustomOptionsSignal.find({
      ...query,
      signal: { $nin: ["ACTIVE"] },
    }).sort({ timestamp: -1 }).limit(200).lean();
    res.json({ success: true, signals, count: signals.length });
  } catch (err) {
    console.error("[ScannerController] getCustomOptions error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getCustomOptionsPreferences = async (req, res) => {
  try {
    const user = _optionalAuth(req);
    if (!user?.id) {
      return res.json({
        success: true,
        customOptionsCallStrike: null,
        customOptionsPutStrike: null,
        customOptionsAlertsEnabled: false,
      });
    }
    const User = require("../models/User");
    const profile = await User.findById(user.id)
      .select("customOptionsCallStrike customOptionsPutStrike customOptionsAlertsEnabled")
      .lean();
    res.json({
      success: true,
      customOptionsCallStrike: profile?.customOptionsCallStrike || null,
      customOptionsPutStrike: profile?.customOptionsPutStrike || null,
      customOptionsAlertsEnabled: profile?.customOptionsAlertsEnabled === true,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

