const { calculateHullSignals } = require("../services/hullScanner");
const { calculateSwingTracker } = require("../services/swingTracker");
const { runBacktest } = require("../services/backtestEngine");

/**
 * Endpoint to fetch historical backtesting data for a specific scanner.
 * Route: GET /api/scanner/:id/backtest?period=60
 */
exports.getBacktest = async (req, res) => {
  try {
    const { id } = req.params;
    const period = parseInt(req.query.period) || 60;

    const result = await runBacktest(id, period);
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

/**
 * Endpoint to compute Exponential Hull Moving Average (EHMA) signals for an index.
 * Body: { candles: Array }
 */
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
const { forceRecalculateScanner, getHistoricalDailyCandles, getStockIndicators, getNseEqUniverse, computeStockMetrics, calculateStrengthScore, fetchHistoricalDailyCandles, getSymbolToTokenMap } = require("../services/scannerEngine");

/**
 * Endpoint to trigger manual recalculation of a specific swing scanner.
 * Route: POST /api/scanner/:id/recalculate
 */
exports.recalculateScanner = async (req, res) => {
  try {
    const { id } = req.params;
    const allowedScanners = ["swing-tracker"];
    if (!allowedScanners.includes(id)) {
      return res.status(400).json({
        success: false,
        message: `Recalculation is only supported for swing scanners: ${allowedScanners.join(", ")}`
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
 * Endpoint to fetch live metrics, historical candles, and technical indicators for a specific stock.
 * Route: GET /api/scanner/stock/:symbol
 */
exports.getStockDetails = async (req, res) => {
  try {
    const symbol = (req.params.symbol || "").toUpperCase();
    if (!symbol) {
      return res.status(400).json({ success: false, message: "Missing stock symbol parameter." });
    }

    const universe = getNseEqUniverse() || [];
    const stockInfo = universe.find(s => s.symbol === symbol);

    const allCandles = getHistoricalDailyCandles() || {};
    let stockCandles = allCandles[symbol];
    const niftyCandles = allCandles["Nifty 50"] || [];

    // If candles are not in local cache, dynamically fetch from SmartAPI
    if (!stockCandles || stockCandles.length === 0) {
      console.log(`[ScannerController] Candles not in cache for ${symbol}, attempting dynamic fetch...`);
      const symbolToTokenMap = getSymbolToTokenMap();
      const symbolKey = `${symbol}-EQ`;
      const instrument = symbolToTokenMap[symbolKey] || symbolToTokenMap[symbol];

      if (!instrument) {
        return res.status(404).json({
          success: false,
          message: `No token mapping found for symbol ${symbol}. Please ensure the stock exists on NSE.`
        });
      }

      const fetched = await fetchHistoricalDailyCandles(symbol, instrument.token, instrument.segment);
      if (!fetched) {
        return res.status(404).json({
          success: false,
          message: `Unable to fetch historical candles for ${symbol}. Please try again later.`
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

/**
 * Endpoint to fetch live commodity prices from the MCX universe.
 * Route: GET /api/scanner/commodities
 */
exports.getCommodities = async (req, res) => {
  try {
    const universe = getCommodityUniverse() || [];
    const ticks = getTickCache() || {};

    const commoditiesData = universe.map(item => {
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
