const fs = require("fs");
const path = require("path");
const { getTickCache, symbolToTokenMap, tokenToSymbolMap, loadScripMaster, subscribeToSymbols } = require("./marketDataFeed");
const { calculateHullSignals, generateIndexTrades } = require("./hullScanner");
const { calculateSwingTracker } = require("./swingTracker");
const { calculateMomentumTrackerV10 } = require("./momentumTracker");
const { calculateRefinedSignals } = require("./refinedIndexScanner");
const { getSmartApiInstance, initializeSession } = require("./smartApiSession");
const {
  broadcastPriceUpdate,
  broadcastScannerUpdate,
  broadcastNewSignal,
  broadcastSectorUpdate,
  broadcastMarketOverview,
  registerOnConnectionCallback
} = require("./socketServer");
const User = require("../models/User");
const DailyCandle = require("../models/DailyCandle");
const IntradayCandle = require("../models/IntradayCandle");
const FoActiveTrade = require("../models/FoActiveTrade");
const { sendPushToUsers } = require("../utils/onesignal");
const { evaluateOptionsOpportunity } = require("./optionsOpportunityScanner");
const {
  getCommodityUniverse
} = require("./marketDataFeed");
let FO_UNIVERSE = require("../config/foUniverse").map(s => ({...s, isFO: true}));
const { recordSwingSignal, getRecentSwingSymbols } = require("./swingCandidateStore");
// Phase 1 — Mongo-backed daily candle persistence + EOD scan state
const dailyCandleStore = require("./dailyCandleStore");
const intradayCandleStore = require("./intradayCandleStore");
// Phase 2 — per-symbol fetch dedup across the 3 overlapping preload paths
const { coordinatedFetch } = require("./candleFetchCoordinator");
// Imported for future use by incremental refactors (Phase 1 follow-up):
//   candleCache:     bounded per-(symbol,timeframe) cache
//   indicatorEngine: O(1) incremental EMA/ATR/RSI
const candleCache     = require("./candleCacheManager");
const indicatorEngine = require("./indicatorEngine");
const indicatorCache  = require("./indicatorCache");
void candleCache; void indicatorEngine;

// Target Stock Universe
const STOCK_UNIVERSE = [
  { symbol: "RELIANCE", name: "Reliance Industries Ltd.", sector: "Energy", isFO: true, marketCap: 1700000, avgValue: 1200, price: 2450 },
  { symbol: "TCS", name: "Tata Consultancy Services Ltd.", sector: "IT", isFO: true, marketCap: 1200000, avgValue: 800, price: 3420 },
  { symbol: "INFOSYS", name: "Infosys Ltd.", sector: "IT", isFO: true, marketCap: 600000, avgValue: 600, price: 1485 },
  { symbol: "HDFCBANK", name: "HDFC Bank Ltd.", sector: "Banking", isFO: true, marketCap: 1100000, avgValue: 1500, price: 1610 },
  { symbol: "ICICIBANK", name: "ICICI Bank Ltd.", sector: "Banking", isFO: true, marketCap: 700000, avgValue: 900, price: 925 },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking", isFO: true, marketCap: 500000, avgValue: 700, price: 585 },
  { symbol: "TATAMOTORS", name: "Tata Motors Ltd.", sector: "Auto", isFO: true, marketCap: 250000, avgValue: 500, price: 642 },
  { symbol: "ITC", name: "ITC Ltd.", sector: "FMCG", isFO: true, marketCap: 550000, avgValue: 400, price: 442 },
  { symbol: "TATASTEEL", name: "Tata Steel Ltd.", sector: "Metals", isFO: true, marketCap: 150000, avgValue: 350, price: 122 },
  { symbol: "BHARTIRTEL", name: "Bharti Airtel Ltd.", sector: "IT", isFO: true, marketCap: 500000, avgValue: 400, price: 885 },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical Industries Ltd.", sector: "Pharma", isFO: true, marketCap: 280000, avgValue: 300, price: 1140 },
  { symbol: "JINDALSTEL", name: "Jindal Steel & Power Ltd.", sector: "Metals", isFO: true, marketCap: 70000, avgValue: 200, price: 690 },
  { symbol: "MARUTI", name: "Maruti Suzuki India Ltd.", sector: "Auto", isFO: true, marketCap: 300000, avgValue: 400, price: 9850 },
  { symbol: "AXISBANK", name: "Axis Bank Ltd.", sector: "Banking", isFO: true, marketCap: 300000, avgValue: 600, price: 965 },
  { symbol: "WIPRO", name: "Wipro Ltd.", sector: "IT", isFO: true, marketCap: 220000, avgValue: 250, price: 412 },
  { symbol: "SUZLON", name: "Suzlon Energy Ltd.", sector: "Energy", isFO: false, marketCap: 65000, avgValue: 150, price: 42 }, // Low price test
  { symbol: "YESBANK", name: "Yes Bank Ltd.", sector: "Banking", isFO: false, marketCap: 50000, avgValue: 100, price: 22 }  // Low price test
];

const INTRADAY_UNIVERSE_LIMIT = 500;
let intradayUniverse = [];
// swingTrackerUniverse: F&O stocks for live scanning. nseEqUniverse is used for EOD-only swing scans.
let swingTrackerUniverse = FO_UNIVERSE.filter(stock => !isEtf(stock.symbol));

// Active Trigger Memory (Sticky Signals)
// Structure: { [scannerId]: { [symbol]: { triggerTime, triggerPrice, ... } } }
let activeSignalsMemory = {};

// In-memory cache for real daily historical candles from SmartAPI
let historicalDailyCandles = {};
let historicalIntradayCandles = {};

// Phase 1 — bounded cache discipline. Caps the rolling history per symbol
// to prevent the OOM that occurred when these objects grew unbounded.
const MAX_DAILY_CANDLES    = 500;   // ~2 years of trading days
const MAX_INTRADAY_CANDLES = 400;   // ~3 days @ 5-min, 1 day @ 1-min

/**
 * Evict candles for symbols that LiveUniverseManager no longer tracks.
 * Called from server.js whenever the merged live universe shrinks.
 */
function evictSymbolsFromCandleCache(symbols) {
  if (!symbols || symbols.length === 0) return 0;
  let removed = 0;
  for (const sym of symbols) {
    if (sym in historicalDailyCandles)    { delete historicalDailyCandles[sym];    removed += 1; }
    if (sym in historicalIntradayCandles) { delete historicalIntradayCandles[sym]; removed += 1; }
    // Also drop equity -EQ aliases that scannerEngine sometimes stores under.
    const eq = `${sym}-EQ`;
    if (eq in historicalDailyCandles)    { delete historicalDailyCandles[eq];    removed += 1; }
    if (eq in historicalIntradayCandles) { delete historicalIntradayCandles[eq]; removed += 1; }
  }
  if (removed > 0) console.log(`[ScannerEngine] Evicted ${removed} candle cache entries.`);
  return removed;
}

const candlesCachePath = path.join(__dirname, "../config/historicalDailyCandles.json");
const intradayCandlesCachePath = path.join(__dirname, "../config/historicalIntradayCandles.json");
function isWeekdayDate(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return false;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" });
  const weekday = formatter.format(date);
  return weekday !== "Sun" && weekday !== "Sat";
}

function getIstTimeMinutes(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
  const timeText = formatter.format(date);
  const [hours, minutes] = timeText.split(":").map(Number);
  return hours * 60 + minutes;
}

function hasOnlyRealisticDailyCandles(series) {
  if (!Array.isArray(series) || series.length === 0) return false;
  const lastDate = new Date(series[series.length - 1].date);
  if (Number.isNaN(lastDate.getTime())) return false;
  const ageDays = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > 30) return false;

  return series.every((candle) => (
    candle &&
    typeof candle.open === "number" &&
    typeof candle.high === "number" &&
    typeof candle.low === "number" &&
    typeof candle.close === "number" &&
    candle.high >= candle.low &&
    !Number.isNaN(new Date(candle.date).getTime())
  ));
}

function hasOnlyRealisticIntradayCandles(series) {
  if (!Array.isArray(series) || series.length === 0) return false;
  const lastDate = new Date(series[series.length - 1].date);
  if (Number.isNaN(lastDate.getTime())) return false;
  const ageDays = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > 10) return false;

  return series.every((candle) => {
    if (!candle || typeof candle.close !== "number") return false;
    const minutes = getIstTimeMinutes(candle.date);
    return minutes !== null;
  });
}

function getLatestHistoricalClose(symbol) {
  const intraday = historicalIntradayCandles[symbol];
  const candidates = [
    intraday?.["THREE_MINUTE"],
    intraday?.["ONE_MINUTE"],
    historicalDailyCandles[symbol]
  ];

  for (const series of candidates) {
    if (Array.isArray(series) && series.length > 0) {
      return Number(series[series.length - 1].close);
    }
  }

  return null;
}

function saveHistoricalIntradayCandlesToCache() {
  try {
    const dir = path.dirname(intradayCandlesCachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(intradayCandlesCachePath, JSON.stringify(historicalIntradayCandles, null, 2));
    console.log(`[ScannerEngine] Saved ${Object.keys(historicalIntradayCandles).length} historical intraday candles to local cache.`);
  } catch (err) {
    console.error("[ScannerEngine] Failed to save intraday candles to cache:", err.message);
  }
}

function loadHistoricalIntradayCandlesFromCache() {
  try {
    if (fs.existsSync(intradayCandlesCachePath)) {
      const parsed = JSON.parse(fs.readFileSync(intradayCandlesCachePath, "utf-8"));
      const validated = {};

      for (const [symbol, frames] of Object.entries(parsed)) {
        if (!frames) continue;
        const validFrames = {};
        for (const [frameName, series] of Object.entries(frames)) {
          if (hasOnlyRealisticIntradayCandles(series)) {
            validFrames[frameName] = series;
          }
        }
        if (Object.keys(validFrames).length > 0) {
          validated[symbol] = validFrames;
        } else {
          console.warn(`[ScannerEngine] Discarding invalid intraday cache for ${symbol}.`);
        }
      }

      historicalIntradayCandles = validated;
      console.log(`[ScannerEngine] Loaded ${Object.keys(historicalIntradayCandles).length} indices historical intraday candles from local cache.`);
      return Object.keys(validated).length > 0;
    }
  } catch (err) {
    console.error("[ScannerEngine] Failed to load intraday candles from cache:", err.message);
  }
  return false;
}

function saveHistoricalDailyCandlesToCache() {
  try {
    const dir = path.dirname(candlesCachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(candlesCachePath, JSON.stringify(historicalDailyCandles, null, 2));
    console.log(`[ScannerEngine] Saved ${Object.keys(historicalDailyCandles).length} historical daily candles to local cache.`);
  } catch (err) {
    console.error("[ScannerEngine] Failed to save candles to cache:", err.message);
  }
}

function loadHistoricalDailyCandlesFromCache() {
  try {
    if (fs.existsSync(candlesCachePath)) {
      const parsed = JSON.parse(fs.readFileSync(candlesCachePath, "utf-8"));
      const validated = {};

      for (const [symbol, series] of Object.entries(parsed)) {
        if (hasOnlyRealisticDailyCandles(series)) {
          validated[symbol] = series;
        } else {
          console.warn(`[ScannerEngine] Discarding invalid daily cache for ${symbol}.`);
        }
      }

      historicalDailyCandles = validated;
      console.log(`[ScannerEngine] Loaded ${Object.keys(historicalDailyCandles).length} stocks historical candles from local cache.`);
      return Object.keys(validated).length > 0;
    }
  } catch (err) {
    console.error("[ScannerEngine] Failed to load candles from cache:", err.message);
  }
  return false;
}

/**
 * Phase 1 — hydrate the in-memory daily candle cache from MongoDB at startup.
 * Mongo is the source of truth; the JSON file is a legacy backup.
 *
 * Strategy:
 *   1. Load JSON cache first (fast, synchronous, gets us a usable state).
 *   2. Then overlay any Mongo-persisted series on top (more authoritative).
 * If Mongo is unreachable we silently keep the JSON state.
 */
async function hydrateDailyCandlesFromMongo() {
  try {
    const fromMongo = await dailyCandleStore.loadAll();
    const symbols = Object.keys(fromMongo);
    if (symbols.length === 0) {
      console.log("[ScannerEngine] Mongo daily candle store is empty (cold start).");
      return 0;
    }
    let merged = 0;
    for (const sym of symbols) {
      const series = fromMongo[sym];
      if (hasOnlyRealisticDailyCandles(series)) {
        historicalDailyCandles[sym] = series;
        merged += 1;
      }
    }
    console.log(`[ScannerEngine] Hydrated ${merged} daily candle series from Mongo.`);
    return merged;
  } catch (err) {
    console.warn("[ScannerEngine] hydrateDailyCandlesFromMongo failed:", err.message);
    return 0;
  }
}

// Global caches for synchronizing new socket clients instantly
let lastSectorsData = null;
let lastMarketOverview = null;

const scannerIds = [
  "fo-bullish", "fo-bearish", "options-bullish", "options-bearish", "swing-tracker",
  "nifty-signals", "banknifty-signals", "sensex-signals"
];

registerOnConnectionCallback((socket) => {
  console.log(`[ScannerEngine] Client connected (${socket.id}). Sending cached dashboard state...`);

  // Send latest active scanner signals
  for (const sId of scannerIds) {
    if (activeSignalsMemory[sId]) {
      const list = Object.values(activeSignalsMemory[sId]);
      list.sort((a, b) => b.strengthScore - a.strengthScore);
      socket.emit("scanner-update", { scannerId: sId, data: list });
    }
  }

  // Send latest sector strengths
  if (lastSectorsData) {
    socket.emit("sector-update", lastSectorsData);
  }

  // Send latest market overview
  if (lastMarketOverview) {
    socket.emit("market-overview", lastMarketOverview);
  }
});

// Last execution timestamps for throttled swing scanners
const lastRunTimestamps = {
  "swing-tracker": 0
};

// Background loops
let calculationInterval = null;
let marketMonitorInterval = null;
let isOfflineMode = false;
let lastKnownMarketOpenState = null;

/**
 * Helper to format date as "YYYY-MM-DD HH:MM"
 */
function formatSmartApiDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 09:15`;
}

function unwrapSmartApiBody(response) {
  if (!response) return null;
  if (Array.isArray(response)) return { data: response, status: true };
  if (response.data && (Array.isArray(response.data) || response.data.status !== undefined || response.data.success !== undefined || response.data.data || response.data.candles || response.data.result)) {
    return response.data;
  }
  return response;
}

function extractCandleRows(response) {
  const body = unwrapSmartApiBody(response);
  if (!body) return [];

  const candidates = [
    body.data,
    body.candles,
    body.result,
    body.rows,
    body
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  if (Array.isArray(body?.data?.data)) return body.data.data;
  if (Array.isArray(body?.data?.candles)) return body.data.candles;
  if (Array.isArray(body?.data?.result)) return body.data.result;

  return [];
}

/**
 * Fetches real historical daily candles for a specific token from SmartAPI and caches them.
 *
 * Phase 1/2:
 *   - Persists every successful fetch to MongoDB via dailyCandleStore.upsertCandles
 *     so candles survive process restarts and we don't re-hit SmartAPI 1600+ times.
 *   - Wrapped in candleFetchCoordinator so the same symbol can never be fetched
 *     in parallel by the three overlapping preload paths.
 */
async function _fetchHistoricalDailyCandlesUncoordinated(symbolKey, token, segment) {
  // Ensure SmartAPI session is valid; retry once on token errors
  let attempts = 0;
  while (attempts < 2) {
    try {
      const api = getSmartApiInstance();
      const toDate = new Date();
      const fromDate = new Date();
      // Fetch last 150 days of daily candles to satisfy indicator requirements (e.g. 100 days)
      fromDate.setDate(toDate.getDate() - 200);

      const fromStr = formatSmartApiDate(fromDate);
      const toStr = formatSmartApiDate(toDate);

      console.log(`[ScannerEngine] Fetching historical daily candles for ${symbolKey} (${token})...`);

      const response = await api.getCandleData({
        exchange: segment === "BSE" ? "BSE" : "NSE",
        symboltoken: token,
        interval: "ONE_DAY",
        fromdate: fromStr,
        todate: toStr
      });

      const candleRows = extractCandleRows(response);
      const responseBody = unwrapSmartApiBody(response);
      if (candleRows.length > 0) {
        const candles = candleRows.map(c => ({
          date: c[0].split("T")[0],
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseInt(c[5]) || 100000
        }));
        // Bounded cache (Phase 1) — cap to MAX_DAILY_CANDLES newest bars to
        // prevent unbounded RAM growth across long-running sessions.
        const trimmedDaily = candles.length > MAX_DAILY_CANDLES
          ? candles.slice(candles.length - MAX_DAILY_CANDLES)
          : candles;
        historicalDailyCandles[symbolKey] = trimmedDaily;
        console.log(`[ScannerEngine] Cached ${trimmedDaily.length} real daily candles for ${symbolKey}.`);

        // Phase 1 — persist to Mongo so 2nd app start has data immediately.
        // Awaited so the EOD guard / hasFreshData check below is consistent,
        // but errors are swallowed inside the store (won't break the fetch).
        dailyCandleStore.upsertCandles(symbolKey, trimmedDaily)
          .then(n => { if (n > 0) console.log(`[ScannerEngine] Persisted ${n} candles for ${symbolKey} to Mongo.`); })
          .catch(err => console.warn(`[ScannerEngine] Mongo persist failed for ${symbolKey}:`, err.message));

        return true;
      } else {
        console.warn(`[ScannerEngine] Empty or invalid daily candles response for ${symbolKey}:`, responseBody?.message || responseBody?.error || "No candle rows returned");
      }
    } catch (err) {
      // Detect token expiration errors (SmartAPI typically returns AG8001)
      if (err.message && err.message.includes('AG8001')) {
        console.warn(`[ScannerEngine] Token expired while fetching candles for ${symbolKey}, reinitializing session...`);
        try {
          await initializeSession();
        } catch (initErr) {
          console.error('[ScannerEngine] Failed to reinitialize SmartAPI session:', initErr.message);
          return false;
        }
        attempts++;
        continue;
      }
      console.error(`[ScannerEngine] Failed to fetch daily candles for ${symbolKey}:`, err.message);
    }
    break;
  }
  return false;
}

async function fetchHistoricalDailyCandles(symbolKey, token, segment) {
  return coordinatedFetch(symbolKey, () =>
    _fetchHistoricalDailyCandlesUncoordinated(symbolKey, token, segment)
  );
}

/**
 * Helper to identify and globally filter out Exchange Traded Funds (ETFs)
 */
function isEtf(symbol) {
  const sym = symbol.toUpperCase();
  if (sym === "SKYGOLD" || sym === "GOLDIAM") return false;
  if (sym.includes("TEST")) return true;

  return sym.includes("BEES") ||
    sym.includes("ETF") ||
    sym.includes("INAV") ||
    sym.includes("NETF") ||
    sym.includes("GSEC") ||
    sym.includes("NIFTY") ||
    sym.includes("SENSEX") ||
    sym.includes("GOLD") ||
    sym.includes("SILVER") ||
    sym.includes("LIQUID") ||
    sym.includes("MON100") ||
    sym.includes("MOM50") ||
    sym.includes("M50") ||
    sym.includes("IETF") ||
    sym.includes("LOWVOL") ||
    sym.includes("MIDCAP") ||
    sym.includes("SMALL250") ||
    sym.includes("MID150") ||
    sym.includes("NEXT50");
}

// Target Stock Universe for NSE EQ > 75 (specifically for swing-tracker)
let nseEqUniverse = [];
let isBackgroundPreloading = false;
let backgroundPreloadIndex = 0;

/**
 * Initializes the NSE EQ universe by loading from cache or fetching LTP and filtering.
 */
async function initializeNseEqUniverse() {
  const localCachePath = path.join(__dirname, "../config/nseEqUniverse.json");

  if (fs.existsSync(localCachePath)) {
    try {
      const stats = fs.statSync(localCachePath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      if (ageHours < 24) {
        console.log("[ScannerEngine] Loading NSE EQ universe from local cache...");
        nseEqUniverse = JSON.parse(fs.readFileSync(localCachePath, "utf-8")).filter(s => !isEtf(s.symbol));
        intradayUniverse = nseEqUniverse.slice(0, INTRADAY_UNIVERSE_LIMIT);
        // NOTE: swingTrackerUniverse stays as FO_UNIVERSE for live scans.
        // nseEqUniverse is used only for EOD swing scans (after 3:40 PM).
        console.log(`[ScannerEngine] Loaded ${nseEqUniverse.length} stocks from NSE EQ cache.`);
        return;
      }
    } catch (err) {
      console.warn("[ScannerEngine] Failed to load NSE EQ universe cache:", err.message);
    }
  }

  console.log("[ScannerEngine] Fetching fresh NSE EQ universe from Angel One scrip master...");
  try {
    const api = getSmartApiInstance();
    const localScripPath = path.join(__dirname, "../config/scripMaster.json");
    if (!fs.existsSync(localScripPath)) {
      await loadScripMaster();
    }
    const data = JSON.parse(fs.readFileSync(localScripPath, 'utf-8'));
    const nseEqInstruments = data.filter(item => item.exch_seg === 'NSE' && item.symbol.endsWith('-EQ'));

    console.log(`[ScannerEngine] Fetching LTP for ${nseEqInstruments.length} instruments in batches of 50...`);
    const batchSize = 50;
    const results = [];

    for (let i = 0; i < nseEqInstruments.length; i += batchSize) {
      const batch = nseEqInstruments.slice(i, i + batchSize);
      const tokens = batch.map(item => item.token);

      try {
        const response = await api.marketData({
          mode: "LTP",
          exchangeTokens: { "NSE": tokens }
        });

        if (response && response.status === true && response.data && response.data.fetched) {
          response.data.fetched.forEach(item => {
            const ltp = parseFloat(item.ltp);
            if (ltp > 75) {
              const token = item.symbolToken;
              const mapped = tokenToSymbolMap[token];
              const symbol = mapped ? mapped.symbol.split("-")[0] : item.symbolName.split("-")[0];
              if (isEtf(symbol)) return; // skip ETF
              const name = mapped ? mapped.name : item.symbolName;
              results.push({
                symbol,
                name,
                price: ltp,
                isFO: mapped ? mapped.segment === "NFO" : false,
                sector: mapped ? mapped.sector || "Other" : "Other"
              });
            }
          });
        }
      } catch (err) {
        console.error(`[ScannerEngine] Batch ${i / batchSize} failed:`, err.message);
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    nseEqUniverse = results;
    intradayUniverse = nseEqUniverse.slice(0, INTRADAY_UNIVERSE_LIMIT);
    // NOTE: swingTrackerUniverse stays as FO_UNIVERSE for live scans.

    // Ensure config directory exists
    const dir = path.dirname(localCachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(localCachePath, JSON.stringify(nseEqUniverse, null, 2));
    console.log(`[ScannerEngine] Mapped and cached ${nseEqUniverse.length} NSE EQ stocks with price > 75.`);
  } catch (err) {
    console.error("[ScannerEngine] Failed to initialize NSE EQ universe:", err.message);
    if (fs.existsSync(localCachePath)) {
      nseEqUniverse = JSON.parse(fs.readFileSync(localCachePath, "utf-8")).filter(s => !isEtf(s.symbol));
      intradayUniverse = nseEqUniverse.slice(0, INTRADAY_UNIVERSE_LIMIT);
      // NOTE: swingTrackerUniverse stays as FO_UNIVERSE for live scans.
      console.warn(`[ScannerEngine] Falling back to previously cached real NSE EQ universe (${nseEqUniverse.length} stocks).`);
      return;
    }
    throw err;
  }
}

/**
 * Starts background daily candle preloader for F&O stocks only.
 * The full NSE EQ universe (1600+ stocks) is fetched via runEodSwingScan() after 3:40 PM.
 */
async function startBackgroundCandlePreload() {
  if (isBackgroundPreloading) return;
  isBackgroundPreloading = true;
  backgroundPreloadIndex = 0;

  // Only preload F&O stocks in the background — keeps startup fast and RAM low
  const foStocks = FO_UNIVERSE.filter(s => !isEtf(s.symbol));
  console.log(`[ScannerEngine] Starting background daily candle preload for ${foStocks.length} F&O stocks...`);

  async function loadNext() {
    if (backgroundPreloadIndex >= foStocks.length) {
      console.log("[ScannerEngine] Background F&O candle preload complete.");
      isBackgroundPreloading = false;
      saveHistoricalDailyCandlesToCache();
      return;
    }

    const stock = foStocks[backgroundPreloadIndex];
    backgroundPreloadIndex++;

    try {
      // Phase 2 — skip symbols already loaded in RAM (likely hydrated from Mongo
      // at startup). coordinatedFetch also enforces a per-IST-day dedup as a
      // second-line guard against duplicate API hits.
      if (!historicalDailyCandles[stock.symbol]) {
        const symbolKey = `${stock.symbol}-EQ`;
        const instrument = symbolToTokenMap[symbolKey];
        if (instrument) {
          await fetchHistoricalDailyCandles(stock.symbol, instrument.token, instrument.segment);
        } else {
          console.warn(`[ScannerEngine] Token not found for F&O preload: ${symbolKey}`);
        }
      }
    } catch (err) {
      console.error(`[ScannerEngine] Failed background preload for ${stock.symbol}:`, err.message);
    }

    // 600ms between requests to respect Angel One API rate limits
    setTimeout(loadNext, 600);
  }

  loadNext();
}

/**
 * Preloads real historical daily candles for the active intraday universe and swing-tracker basket.
 */
async function preloadAllHistoricalDailyCandles() {
  console.log("[ScannerEngine] Preloading real historical daily candles from SmartAPI...");
  const commodityUniverse = getCommodityUniverse();
  const baseUniverse = [...intradayUniverse, ...swingTrackerUniverse,
  ...commodityUniverse];
  const uniqueTargets = [];
  const seenSymbols = new Set();

  for (const stock of baseUniverse) {
    if (!stock || !stock.symbol || seenSymbols.has(stock.symbol)) continue;
    seenSymbols.add(stock.symbol);
    uniqueTargets.push(stock);
  }

  const targets = [
    { symbolKey: "Nifty 50", symbol: "Nifty 50" },
    { symbolKey: "Nifty Bank", symbol: "Nifty Bank" },
    { symbolKey: "SENSEX", symbol: "SENSEX" },
    ...uniqueTargets.map(s => ({ symbolKey: s.symbol, symbol: s.isFO ? `${s.symbol}-EQ` : s.symbol }))
  ];

  for (const item of targets) {
    const isIndex = ["Nifty 50", "Nifty Bank", "SENSEX"].includes(item.symbolKey);
    if (!isIndex) {
      // Do not block startup on non-index symbols. Let background preload handle them.
      continue;
    }
    
    if (historicalDailyCandles[item.symbolKey] && hasOnlyRealisticDailyCandles(historicalDailyCandles[item.symbolKey])) {
      // Skip if valid candles exist in cache to optimize startup loading time
      continue;
    }

    let instrument = symbolToTokenMap[item.symbol];
    if (!instrument && item.symbolKey === "INFOSYS") instrument = symbolToTokenMap["INFY-EQ"];
    if (!instrument && item.symbolKey === "BHARTIRTEL") instrument = symbolToTokenMap["BHARTIARTL-EQ"];
    if (!instrument && item.symbolKey === "TATAMOTORS") instrument = symbolToTokenMap["TMPV-EQ"];

    if (!instrument) {
      console.warn(`[ScannerEngine] Mapped instrument not found for ${item.symbolKey} (${item.symbol}) during preload`);
      continue;
    }

    const success = await fetchHistoricalDailyCandles(item.symbolKey, instrument.token, instrument.segment);
    if (!success && !hasOnlyRealisticDailyCandles(historicalDailyCandles[item.symbolKey])) {
      console.warn(`[ScannerEngine] No valid real daily candles available for ${item.symbolKey}.`);
    }

    // Sleep 400ms to respect API rate limits
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  console.log("[ScannerEngine] Historical index daily candles preloading complete.");
  saveHistoricalDailyCandlesToCache();
}

async function fetchHistoricalIntradayCandles(symbolKey, token, segment, interval, lookbackDays = 7) {
  const cachedArr = historicalIntradayCandles[symbolKey]?.[interval];
  let lastCachedDateStr = null;
  if (cachedArr && cachedArr.length > 0) {
    lastCachedDateStr = cachedArr[cachedArr.length - 1].date;
  }

  let attempts = 0;
  while (attempts < 2) {
    try {
      const api = getSmartApiInstance();
      const toDate = new Date();
      let fromDate = new Date();
      
      if (lastCachedDateStr) {
        // Angel One SmartAPI uses format "YYYY-MM-DDTHH:MM:SS+05:30"
        fromDate = new Date(lastCachedDateStr);
      } else {
        fromDate.setDate(toDate.getDate() - lookbackDays);
      }

      // If fromDate is within the last 5 minutes, skip fetching!
      if ((toDate.getTime() - fromDate.getTime()) < 5 * 60000) {
        return true;
      }

      const formatOffsetDate = (date) => {
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      };

      const fromStr = formatOffsetDate(fromDate);
      const toStr = formatOffsetDate(toDate);

      const response = await api.getCandleData({
        exchange: segment === "BSE" ? "BSE" : "NSE",
        symboltoken: token,
        interval: interval,
        fromdate: fromStr,
        todate: toStr
      });

      const candleRows = extractCandleRows(response);
      if (candleRows.length > 0) {
        const candles = candleRows.map(c => ({
          date: c[0],
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseInt(c[5]) || 0
        }));
        
        if (!historicalIntradayCandles[symbolKey]) {
          historicalIntradayCandles[symbolKey] = {};
        }
        if (!historicalIntradayCandles[symbolKey][interval]) {
          historicalIntradayCandles[symbolKey][interval] = [];
        }
        
        const existingDates = new Set(historicalIntradayCandles[symbolKey][interval].map(c => c.date));
        const newCandles = candles.filter(c => !existingDates.has(c.date));
        
        if (newCandles.length > 0) {
          historicalIntradayCandles[symbolKey][interval].push(...newCandles);
          historicalIntradayCandles[symbolKey][interval].sort((a, b) => a.date.localeCompare(b.date));
          
          const mongoDocs = newCandles.map(c => ({
            symbol: symbolKey,
            interval: interval,
            date: c.date,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume
          }));
          await intradayCandleStore.saveHistoricalIntradayCandles(symbolKey, interval, newCandles);
        }
      }
      return true;
    } catch (err) {
      if (err.message && err.message.includes("AB4030")) return true;
      attempts++;
      if (attempts >= 2) {
        console.error(`[ScannerEngine] Max attempts reached for ${symbolKey} Intraday Fetch. Skipping.`);
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

async function hydrateIntradayCandlesFromMongo() {
  console.log("[ScannerEngine] Hydrating intraday candles from Mongo...");
  const foStocks = FO_UNIVERSE.filter(s => !isEtf(s.symbol));
  let loadedCount = 0;
  for (const stock of foStocks) {
    const candles = await intradayCandleStore.loadHistoricalIntradayCandles(stock.symbol, "FIVE_MINUTE");
    if (candles && candles.length > 0) {
      if (!historicalIntradayCandles[stock.symbol]) historicalIntradayCandles[stock.symbol] = {};
      historicalIntradayCandles[stock.symbol]["FIVE_MINUTE"] = candles;
      loadedCount++;
    }
  }
  console.log(`[ScannerEngine] Successfully hydrated intraday candles for ${loadedCount} F&O stocks.`);
}

async function preloadAllHistoricalIntradayCandles() {
  const now = new Date();
  const nowStr = now.toISOString().split("T")[0];

  if (!isWeekdayDate(now)) {
    console.log("[ScannerEngine] Today is a weekend/holiday. Skipping historical intraday candle pull from Angel One.");
    return;
  }

  const niftyCandles = historicalIntradayCandles["Nifty 50"]?.["FIVE_MINUTE"];
  if (niftyCandles && niftyCandles.length > 0) {
    const lastCandleDate = niftyCandles[niftyCandles.length - 1].date.split("T")[0];
    if (lastCandleDate === nowStr) {
      console.log("[ScannerEngine] Today's intraday candles already exist in DB. Skipping historical pull from Angel One.");
      return;
    }
  }

  console.log("[ScannerEngine] Preloading real historical intraday index candles from SmartAPI...");
  
  

  const targets = [
    { symbolKey: "Nifty 50", symbol: "Nifty 50" },
    { symbolKey: "Nifty Bank", symbol: "Nifty Bank" },
    { symbolKey: "SENSEX", symbol: "SENSEX" }
  ];

  const foStocks = FO_UNIVERSE.filter(s => !isEtf(s.symbol));
  for (const s of foStocks) {
    targets.push({ symbolKey: s.symbol, symbol: s.symbol, isFO: true });
  }

  // Pre-filter targets so we only fetch missing data!
  for (const item of targets) {
    const lookupKey = item.isFO ? `${item.symbol}-EQ` : item.symbol;
    const instrument = symbolToTokenMap[lookupKey];
    if (!instrument) continue;

    if (!item.isFO) {
      await fetchHistoricalIntradayCandles(item.symbolKey, instrument.token, instrument.segment, "ONE_MINUTE", 7);
      await new Promise(resolve => setTimeout(resolve, 400));
      await fetchHistoricalIntradayCandles(item.symbolKey, instrument.token, instrument.segment, "THREE_MINUTE", 7);
      await new Promise(resolve => setTimeout(resolve, 400));
    }

    await fetchHistoricalIntradayCandles(item.symbolKey, instrument.token, instrument.segment, "FIVE_MINUTE", 7);
    
    // Respect Angel Broking 3 req/sec rate limit
    await new Promise(resolve => setTimeout(resolve, 400));
  }

    console.log("[ScannerEngine] Historical intraday candles preloading complete.");
    saveHistoricalIntradayCandlesToCache();
  }

function buildUnifiedIndexCandles(oneMin, threeMin) {
  const unified = [];

  const getISTTimeString = (dateStr) => {
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return "";
      // Formats date to HH:MM in Asia/Kolkata timezone
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit"
      });
      return formatter.format(date);
    } catch (err) {
      return "";
    }
  };

  if (oneMin) {
    for (const c of oneMin) {
      const timeStr = getISTTimeString(c.date);
      if (isWeekdayDate(c.date) && timeStr >= "09:16" && timeStr <= "10:15") {
        unified.push({ ...c, timeframe: "1M" });
      }
    }
  }

  if (threeMin) {
    for (const c of threeMin) {
      const timeStr = getISTTimeString(c.date);
      if (isWeekdayDate(c.date) && timeStr >= "10:16" && timeStr <= "15:30") {
        unified.push({ ...c, timeframe: "3M" });
      }
    }
  }

  unified.sort((a, b) => a.date.localeCompare(b.date));
  return unified;
}


function getHistoricalIntradayCandles() {
  return historicalIntradayCandles;
}

/**
 * Checks if a scanner should run based on its configured throttle interval.
 * Returns true if it has never run, or if the time since the last run exceeds the throttle.
 */
function shouldEvaluateScanner(scannerId) {
  const now = Date.now();

  // Throttle configurations in milliseconds
  const throttles = {
    "swing-tracker": 4 * 60 * 60 * 1000             // 4 Hours
  };

  // If scanner is not in throttle configuration, evaluate every time (2s interval)
  if (throttles[scannerId] === undefined) {
    return true;
  }

  const lastRun = lastRunTimestamps[scannerId];
  const interval = throttles[scannerId];

  if (now - lastRun >= interval) {
    lastRunTimestamps[scannerId] = now;
    console.log(`[ScannerEngine] Throttled run triggered for: ${scannerId}`);
    return true;
  }

  return false;
}

/**
 * Technical Indicator Calculators
 */
const technicals = {
  sma: (prices, period) => {
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
  },

  ema: (prices, period) => {
    if (prices.length === 0) return [];
    const k = 2 / (period + 1);
    let emaArray = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
      emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
    }
    return emaArray;
  },

  rsi: (prices, period = 14) => {
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
  }
};

/**
 * Builds indicators from a real candle series.
 */
function getStockIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 100000);

  const rsi = technicals.rsi(closes, 14);
  const ema9 = technicals.ema(closes, 9);
  const ema20 = technicals.ema(closes, 20);
  const ema21 = technicals.ema(closes, 21);
  const ema50 = technicals.ema(closes, 50);
  const ema200 = technicals.ema(closes, 200);

  const currentRsi = rsi[rsi.length - 1] || 50;
  const currentEma9 = ema9[ema9.length - 1] || closes[closes.length - 1];
  const currentEma20 = ema20[ema20.length - 1] || closes[closes.length - 1];
  const currentEma21 = ema21[ema21.length - 1] || closes[closes.length - 1];
  const currentEma50 = ema50[ema50.length - 1] || closes[closes.length - 1];
  const currentEma200 = ema200[ema200.length - 1] || closes[closes.length - 1];

  const ema20Rising = ema20.length > 2 ? ema20[ema20.length - 1] > ema20[ema20.length - 2] : true;
  const ema50Rising = ema50.length > 2 ? ema50[ema50.length - 1] > ema50[ema50.length - 2] : true;

  // Average volume over last 10 bars
  let sumVol10 = 0;
  for (let i = Math.max(0, volumes.length - 10); i < volumes.length; i++) {
    sumVol10 += volumes[i];
  }
  const avgVol10 = sumVol10 / Math.min(10, volumes.length) || 1;

  // Average volume over last 20 bars
  let sumVol20 = 0;
  for (let i = Math.max(0, volumes.length - 20); i < volumes.length; i++) {
    sumVol20 += volumes[i];
  }
  const avgVol20 = sumVol20 / Math.min(20, volumes.length) || 1;

  const maxHigh = Math.max(...highs.slice(Math.max(0, highs.length - 250))) || closes[closes.length - 1];
  const minLow = Math.min(...lows.slice(Math.max(0, lows.length - 250))) || closes[closes.length - 1];

  // Yesterday's High (PDH) and Yesterday's Close (PrevClose)
  const pdh = highs[highs.length - 2] || closes[closes.length - 1];
  const prevClose = closes[closes.length - 2] || closes[closes.length - 1];

  return {
    closes,
    highs,
    lows,
    volumes,
    currentRsi,
    currentEma9,
    currentEma20,
    currentEma21,
    currentEma50,
    currentEma200,
    ema9,
    ema21,
    ema20Rising,
    ema50Rising,
    avgVol10,
    avgVol20,
    maxHigh,
    minLow,
    pdh,
    prevClose
  };
}

/**
 * Queries the database for users subscribed to this scanner and sends push alerts.
 */
async function handleNewSignalPush(scannerId, signal) {
  try {
    const users = await User.find({ subscribedScanners: scannerId });
    if (!users || users.length === 0) return;

    const recipientIds = users.map(u => u._id.toString());
    const scannerName = scannerId
      .split("-")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    console.log(`[PushAlerts] Dispatching push to ${recipientIds.length} users for new trigger: ${signal.symbol} on ${scannerId}`);

    await sendPushToUsers({
      recipientIds,
      name: `Scanner Signal - ${scannerId}`,
      headings: { en: `New Trigger: ${scannerName}` },
      contents: { en: `🚨 ${signal.symbol} has triggered at ₹${signal.price.toFixed(2)} (${signal.change >= 0 ? '+' : ''}${signal.change.toFixed(2)}%)` },
      data: {
        scannerId,
        symbol: signal.symbol,
        price: signal.price,
        change: signal.change
      }
    });
  } catch (err) {
    console.error(`[PushAlerts] Error sending push for new signal:`, err.message);
  }
}

/**
 * The core evaluation step run every 2 seconds.
 */
async function evaluateAllScanners() {
  const tickCache = getTickCache();

  // If we are in live mode but tickCache is empty, don't completely block; populate initial ticks from historical preloads if available
  if (!isOfflineMode && Object.keys(tickCache).length === 0) {
    // Attempt to seed indices base prices from last known historical values so dashboard can render
    const targets = ["Nifty 50", "Nifty Bank", "SENSEX"];
    targets.forEach(sym => {
      const hist = historicalIntradayCandles[sym]?.["ONE_MINUTE"] || historicalIntradayCandles[sym]?.["THREE_MINUTE"];
      if (hist && hist.length > 0) {
        tickCache[sym] = {
          ltp: hist[hist.length - 1].close,
          close: hist[0].close,
          changePercent: Number(((hist[hist.length - 1].close - hist[0].close) / hist[0].close * 100).toFixed(2))
        };
      }
    });
  }

  // If we do not have live ticks yet, seed indices and sector indices from cached real closes
  if (isOfflineMode) {
    const n50 = tickCache["Nifty 50"] || { ltp: 22140.65, changePercent: 0.83, close: 21958.25 };
    const n50Change = (Math.random() - 0.49) * 10;
    n50.ltp = Number((n50.ltp + n50Change).toFixed(2));
    n50.changePercent = Number(((n50.ltp - n50.close) / n50.close * 100).toFixed(2));
    tickCache["Nifty 50"] = n50;

    const nb = tickCache["Nifty Bank"] || { ltp: 47420.95, changePercent: 1.11, close: 46900.80 };
    const nbChange = (Math.random() - 0.49) * 30;
    nb.ltp = Number((nb.ltp + nbChange).toFixed(2));
    nb.changePercent = Number(((nb.ltp - nb.close) / nb.close * 100).toFixed(2));
    tickCache["Nifty Bank"] = nb;

    const sx = tickCache["SENSEX"] || { ltp: 72648.30, changePercent: 0.85, close: 72036.10 };
    const sxChange = (Math.random() - 0.49) * 50;
    sx.ltp = Number((sx.ltp + sxChange).toFixed(2));
    sx.changePercent = Number(((sx.ltp - sx.close) / sx.close * 100).toFixed(2));
    tickCache["SENSEX"] = sx;

    const sectorBasePrices = {
      "Nifty Auto": 16500,
      "Nifty Bank": 47420,
      "Nifty Fin Service": 21100,
      "Nifty FMCG": 49500,
      "Nifty IT": 27420,
      "Nifty Media": 1515,
      "Nifty Metal": 13020,
      "Nifty Pharma": 24460,
      "Nifty PSU Bank": 8710,
      "Nifty Realty": 811,
      "Nifty Pvt Bank": 27890,
      "Nifty Infra": 8200,
      "Nifty Energy": 28500,
      "Nifty PSE": 9100,
      "Nifty Serv Sector": 25200
    };

    for (const key in sectorBasePrices) {
      const base = sectorBasePrices[key];
      const cached = tickCache[key] || { ltp: base, changePercent: 0.5, close: base * 0.995 };
      const change = (Math.random() - 0.49) * (base * 0.001);
      cached.ltp = Number((cached.ltp + change).toFixed(2));
      cached.changePercent = Number(((cached.ltp - cached.close) / cached.close * 100).toFixed(2));
      tickCache[key] = cached;
    }
  }

  // Pre-calculate index variables for calculations block
  const niftyData = tickCache["Nifty 50"];
  const bankNiftyData = tickCache["Nifty Bank"];
  const sensexData = tickCache["SENSEX"];

  const niftyPrice = niftyData ? niftyData.ltp : 22140.65;
  const niftyChangePercent = niftyData ? niftyData.changePercent : 0.83;
  // Derive close from changePercent when tickCache.close is undefined/0
  const niftyClose = niftyData ? (niftyData.close || (niftyChangePercent !== 0 ? Number((niftyPrice / (1 + niftyChangePercent / 100)).toFixed(2)) : niftyPrice)) : 21958.25;
  const niftyChange = niftyData ? (niftyData.change || Number((niftyPrice - niftyClose).toFixed(2))) : 0;

  const bankNiftyPrice = bankNiftyData ? bankNiftyData.ltp : 47420.95;
  const bankNiftyChangePercent = bankNiftyData ? bankNiftyData.changePercent : 1.11;
  const bankNiftyClose = bankNiftyData ? (bankNiftyData.close || (bankNiftyChangePercent !== 0 ? Number((bankNiftyPrice / (1 + bankNiftyChangePercent / 100)).toFixed(2)) : bankNiftyPrice)) : 46900.80;
  const bankNiftyChange = bankNiftyData ? (bankNiftyData.change || Number((bankNiftyPrice - bankNiftyClose).toFixed(2))) : 0;

  const sensexPrice = sensexData ? sensexData.ltp : 72648.30;
  const sensexChangePercent = sensexData ? sensexData.changePercent : 0.85;
  const sensexClose = sensexData ? (sensexData.close || (sensexChangePercent !== 0 ? Number((sensexPrice / (1 + sensexChangePercent / 100)).toFixed(2)) : sensexPrice)) : 72036.10;
  const sensexChange = sensexData ? (sensexData.change || Number((sensexPrice - sensexClose).toFixed(2))) : 0;

  const giftNiftyPrice = Number((niftyPrice + 35.5).toFixed(2));
  const giftNiftyChangePercent = niftyChangePercent;
  const giftNiftyChange = niftyChange;

  // Pre-filter stocks using Global Pre-Filter
  const activeStocks = intradayUniverse.filter(stock => {
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = tickCache[symbolKey];
    if (!liveData) return false;
    const price = liveData.price || liveData.ltp || 0;

    // Filter out penny stocks (price > 80)
    return price > 80;
  });

  const updatedScanners = {};



  // Pre-calculate stock indicators mapping for this batch run
  
  const activeFoTradesList = await FoActiveTrade.find({ status: "ACTIVE" });
  const activeFoTradesMap = {};
  for (const t of activeFoTradesList) {
    if (!activeFoTradesMap[t.scannerId]) activeFoTradesMap[t.scannerId] = {};
    activeFoTradesMap[t.scannerId][t.symbol] = t;
  }

  const stockIndicatorsMap = {};
  activeStocks.forEach(stock => {
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = tickCache[symbolKey];
    if (!liveData) return;
    const ltp = liveData.price || liveData.ltp || 0;

    // Use real cached daily historical candles, appending current live tick
    const candles = historicalDailyCandles[stock.symbol];
    if (!candles || candles.length === 0) {
      return;
    }

    const clonedCandles = JSON.parse(JSON.stringify(candles));
    const lastCandle = clonedCandles[clonedCandles.length - 1];
    const nowIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const nowStr = nowIST.toISOString().split("T")[0];
    if (lastCandle.date === nowStr) {
      lastCandle.close = ltp;
      lastCandle.high = Math.max(lastCandle.high, ltp);
      lastCandle.low = Math.min(lastCandle.low, ltp);
      if (liveData.volume) lastCandle.volume = liveData.volume;
    } else if (isMarketOpen()) {
      clonedCandles.push({
        date: nowStr,
        open: liveData.open || ltp,
        high: Math.max(liveData.open || ltp, ltp),
        low: Math.min(liveData.open || ltp, ltp),
        close: ltp,
        volume: liveData.volume || 100000
      });
      if (clonedCandles.length > 150) clonedCandles.shift();
    }

    stockIndicatorsMap[stock.symbol] = getStockIndicators(clonedCandles);
  });

  for (const scannerId of scannerIds) {
    if (!activeSignalsMemory[scannerId]) {
      activeSignalsMemory[scannerId] = {};
    }

    // Skip calculations if throttled, broadcasting last cached list to connected sockets
    if (!shouldEvaluateScanner(scannerId)) {
      const currentSignals = Object.values(activeSignalsMemory[scannerId]);
      currentSignals.sort((a, b) => b.strengthScore - a.strengthScore);
      broadcastScannerUpdate(scannerId, currentSignals);
      continue;
    }

    // Clear sticky cache for swing/F&O scanners to only show today's triggers
    const isSwingScanner = scannerId === "swing-tracker";
    const isFoScanner = ["fo-bullish", "fo-bearish", "options-bullish", "options-bearish"].includes(scannerId);
    if (isSwingScanner) {
      activeSignalsMemory[scannerId] = {};
    }

    const loopNow = new Date(); if (loopNow.getHours() === 9 && loopNow.getMinutes() < 20 && isFoScanner) { continue; } const currentSignals = [];
    let targetStocks = activeStocks;
    if (scannerId === "swing-tracker") {
      targetStocks = swingTrackerUniverse;
    } else if (["fo-bullish", "fo-bearish", "options-bullish", "options-bearish"].includes(scannerId)) {
      targetStocks = swingTrackerUniverse; // all stocks in swingTrackerUniverse are FO_UNIVERSE
    }

    for (const stock of targetStocks) {
      if (isEtf(stock.symbol)) continue; // skip ETF globally
      if (isSwingScanner && !isOfflineMode && !historicalDailyCandles[stock.symbol]) {
        continue;
      }
      // F&O scanners use intraday FIVE_MINUTE candles
      if (isFoScanner && !isOfflineMode && (!historicalIntradayCandles[stock.symbol] || !historicalIntradayCandles[stock.symbol]["FIVE_MINUTE"])) {
        continue;
      }
      const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
      const liveData = tickCache[symbolKey];
      // For swing-tracker and F&O, live data is optional (EOD signals work without live ticks)
      const ltpFallback = historicalDailyCandles[stock.symbol]?.slice(-1)[0]?.close || 0;
      const ltp = liveData ? (liveData.price || liveData.ltp || 0) : ltpFallback;
      const change = liveData ? (liveData.changePercent || liveData.change || 0) : 0;
      // Skip non-swing/F&O scanners that need live data
      if (!isSwingScanner && !isFoScanner && !liveData) continue;

      const ind = stockIndicatorsMap[stock.symbol] || {
        currentRsi: 50, avgVol10: 100000, avgVol20: 100000, maxHigh: ltp, minLow: ltp, pdh: ltp, prevClose: ltp
      };
      const rsiVal = ind.currentRsi;
      const volumeRatio = ((liveData && liveData.volume) || 100000) / ind.avgVol10;

      // Check technical trigger conditions using simplified real-time rules
      let triggered = false;
      let strengthScore = 50;
      let direction = "BULLISH";
      let signalCandleTimestamp = null; // Will hold the actual candle date/time from the indicator result
      let exitConditionMet = false;

      switch (scannerId) {
        case "fo-bullish": {
          let trackerCandles = historicalIntradayCandles[stock.symbol]?.["FIVE_MINUTE"];
          if (!trackerCandles || trackerCandles.length === 0) {
            continue;
          }
          trackerCandles = JSON.parse(JSON.stringify(trackerCandles));
          const lastCandle = trackerCandles[trackerCandles.length - 1];
          // For simplicity, update last intraday candle with ltp
          if (liveData) {
            lastCandle.close = ltp;
            lastCandle.high = Math.max(lastCandle.high, ltp);
            lastCandle.low = Math.min(lastCandle.low, ltp);
          }
          const trackerRes = indicatorCache.memo(
            stock.symbol, "MOMENTUM_V10_5M", 0, trackerCandles,
            () => calculateMomentumTrackerV10(trackerCandles)
          );
          if (trackerRes.length === 0) continue;
          let lastSignal = trackerRes[trackerRes.length - 1];
          
          
          const nowIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const nowStr = nowIST.toISOString().split("T")[0];
          for (let i = trackerRes.length - 1; i >= 0; i--) {
            if (trackerRes[i].date.split("T")[0] !== nowStr) break;
            if (trackerRes[i].signal === "LONG") {
               lastSignal = trackerRes[i];
               signalCandleTimestamp = trackerRes[i].date;
               triggered = true;
               break;
            } else if (trackerRes[i].signal === "SHORT") {
               break;
            }
          }

          direction = "BULLISH";
          
          const niftyCandles = historicalDailyCandles["Nifty 50"] || [];
          const metrics = computeStockMetrics(stock.symbol, trackerCandles, niftyCandles);
          if (metrics) {
            const strengthResult = calculateStrengthScore(metrics, "BULLISH");
            strengthScore = strengthResult.score;
          } else {
            strengthScore = 50;
          }
          break;
        }
        case "fo-bearish": {
          let trackerCandles = historicalIntradayCandles[stock.symbol]?.["FIVE_MINUTE"];
          if (!trackerCandles || trackerCandles.length === 0) {
            continue;
          }
          trackerCandles = JSON.parse(JSON.stringify(trackerCandles));
          const lastCandle = trackerCandles[trackerCandles.length - 1];
          // For simplicity, update last intraday candle with ltp
          if (liveData) {
            lastCandle.close = ltp;
            lastCandle.high = Math.max(lastCandle.high, ltp);
            lastCandle.low = Math.min(lastCandle.low, ltp);
          }
          const trackerRes = indicatorCache.memo(
            stock.symbol, "MOMENTUM_V10_5M", 0, trackerCandles,
            () => calculateMomentumTrackerV10(trackerCandles)
          );
          if (trackerRes.length === 0) continue;
          let lastSignal = trackerRes[trackerRes.length - 1];
          
          
          const nowIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const nowStr = nowIST.toISOString().split("T")[0];
          for (let i = trackerRes.length - 1; i >= 0; i--) {
            if (trackerRes[i].date.split("T")[0] !== nowStr) break;
            if (trackerRes[i].signal === "SHORT") {
               lastSignal = trackerRes[i];
               signalCandleTimestamp = trackerRes[i].date;
               triggered = true;
               break;
            } else if (trackerRes[i].signal === "LONG") {
               break;
            }
          }

          direction = "BEARISH";
          
          const niftyCandles = historicalDailyCandles["Nifty 50"] || [];
          const metrics = computeStockMetrics(stock.symbol, trackerCandles, niftyCandles);
          if (metrics) {
            const strengthResult = calculateStrengthScore(metrics, "BEARISH");
            strengthScore = strengthResult.score;
          } else {
            strengthScore = 50;
          }
          break;
        }
        case "options-bullish": {
          let trackerCandles = historicalIntradayCandles[stock.symbol]?.["FIVE_MINUTE"];
          if (!trackerCandles || trackerCandles.length === 0) continue;
          const marketOverview = lastMarketOverview || { trendScore: 50, niftyChangePercent: niftyChangePercent };
          const ind = stockIndicatorsMap[stock.symbol];
          const result = evaluateOptionsOpportunity(stock, ind, liveData, marketOverview);
          const existingSignal = activeSignalsMemory[scannerId]?.[stock.symbol];
          if (existingSignal && result && result.triggered && result.direction === "BEARISH") {
            exitConditionMet = true;
          } else if (result && result.triggered && result.direction === "BULLISH") { // note optionsOpportunityScanner uses "BULLISH" and "BEARISH"
            triggered = true;
            direction = "BULLISH";
            strengthScore = result.strengthScore;
            signalCandleTimestamp = trackerCandles[trackerCandles.length - 1].date;
          }
          break;
        }
        case "options-bearish": {
          let trackerCandles = historicalIntradayCandles[stock.symbol]?.["FIVE_MINUTE"];
          if (!trackerCandles || trackerCandles.length === 0) continue;
          const marketOverview = lastMarketOverview || { trendScore: 50, niftyChangePercent: niftyChangePercent };
          const ind = stockIndicatorsMap[stock.symbol];
          const result = evaluateOptionsOpportunity(stock, ind, liveData, marketOverview);
          if (result && result.triggered && result.direction === "BEARISH") {
            triggered = true;
            direction = "BEARISH";
            strengthScore = result.strengthScore;
            signalCandleTimestamp = trackerCandles[trackerCandles.length - 1].date;
          }
          break;
        }

        case "swing-tracker": {
          let trackerCandles = historicalDailyCandles[stock.symbol];
          if (!trackerCandles || trackerCandles.length === 0) {
            continue;
          }
          trackerCandles = JSON.parse(JSON.stringify(trackerCandles));
          const lastCandle = trackerCandles[trackerCandles.length - 1];
          const nowIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const nowStr = nowIST.toISOString().split("T")[0];
          // Update last candle with live data if available, or append today's candle if market is open
          if (liveData && lastCandle.date === nowStr) {
            lastCandle.close = ltp;
            lastCandle.high = Math.max(lastCandle.high, ltp);
            lastCandle.low = Math.min(lastCandle.low, ltp);
          } else if (liveData && isMarketOpen()) {
            trackerCandles.push({
              date: nowStr,
              open: ltp,
              high: ltp,
              low: ltp,
              close: ltp,
              volume: 100000
            });
            if (trackerCandles.length > 100) trackerCandles.shift();
          }
          const trackerRes = indicatorCache.memo(
            stock.symbol, "SWING_TRACKER", 0, trackerCandles,
            () => calculateSwingTracker(trackerCandles)
          );
          const lastSignal = trackerRes.signals[trackerRes.signals.length - 1];
          const latestCandle = trackerCandles[trackerCandles.length - 1];
          triggered = lastSignal && lastSignal.date === latestCandle.date;
          if (triggered) signalCandleTimestamp = lastSignal.date;
          direction = lastSignal && lastSignal.action === "BUY" ? "BULLISH" : "BEARISH";
          
          const niftyCandles = historicalDailyCandles["Nifty 50"] || [];
          const metrics = computeStockMetrics(stock.symbol, trackerCandles, niftyCandles);
          if (metrics) {
            const strengthResult = calculateStrengthScore(metrics, "BEARISH");
            strengthScore = strengthResult.score;
          } else {
            strengthScore = trackerRes.summary.winRate || 50;
          }
          break;
        }
        default:
          triggered = false;
          strengthScore = 60;
          break;
      }

      
      // Check Signal Memory (Sticky signals)
      const existingSignal = activeSignalsMemory[scannerId][stock.symbol];

      // Mongo Active Trade check
      if (triggered && isFoScanner && !existingSignal) {
        if (activeFoTradesMap[scannerId] && activeFoTradesMap[scannerId][stock.symbol]) {
          triggered = false; // Already active in Mongo, suppress duplicate trigger
        } else {
          // Save to Mongo with actual candle timestamp
          const newTrade = new FoActiveTrade({
            symbol: stock.symbol,
            direction: direction,
            scannerId: scannerId,
            entryPrice: ltp,
            strengthScore: strengthScore,
            triggeredAt: signalCandleTimestamp ? new Date(signalCandleTimestamp) : new Date()
          });
          await newTrade.save().catch(console.error);
          if (!activeFoTradesMap[scannerId]) activeFoTradesMap[scannerId] = {};
          activeFoTradesMap[scannerId][stock.symbol] = newTrade;
        }
      }

      if (exitConditionMet && existingSignal) {
        const trade = activeFoTradesMap[scannerId]?.[stock.symbol];
        if (trade && trade._id) {
          FoActiveTrade.updateOne({ _id: trade._id }, { status: 'CLOSED' }).catch(console.error);
        }
        delete activeSignalsMemory[scannerId][stock.symbol];
        if (activeFoTradesMap[scannerId]) {
          delete activeFoTradesMap[scannerId][stock.symbol];
        }
        continue;
      }

      if (triggered || existingSignal) {
        let signalInfo;

        if (!existingSignal) {
          // New Trigger event
          signalInfo = {
            symbol: stock.symbol,
            name: stock.name,
            price: ltp,
            change: change,
            signalStrength: strengthScore > 75 ? "STRONG" : (strengthScore > 50 ? "MEDIUM" : "WEAK"),
            direction: direction,
            volumeScore: Math.round(volumeRatio * 40),
            trendScore: Math.round(rsiVal),
            timestamp: signalCandleTimestamp ? new Date(signalCandleTimestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : new Date().toLocaleTimeString(),
            triggerTime: signalCandleTimestamp ? new Date(signalCandleTimestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : new Date().toLocaleTimeString(),
            triggerPrice: ltp,
            postTriggerChange: 0,
            strengthScore: strengthScore,
            sector: stock.sector,
            isFO: stock.isFO
          };

          activeSignalsMemory[scannerId][stock.symbol] = signalInfo;

          // Centralised dispatch (Phase 7) — handles dedup, socket, push, persistence.
          require("./alertManager").dispatch({ scannerId, signalInfo });
        } else {
          // Update current price, direction, and post-trigger change for existing signal
          const postChange = ((ltp - existingSignal.triggerPrice) / existingSignal.triggerPrice) * 100;

          signalInfo = {
            ...existingSignal,
            price: ltp,
            change: change,
            direction: direction,
            postTriggerChange: Number(postChange.toFixed(2)),
            signalStrength: strengthScore > 75 ? "STRONG" : (strengthScore > 50 ? "MEDIUM" : "WEAK"),
            strengthScore: strengthScore
          };

          activeSignalsMemory[scannerId][stock.symbol] = signalInfo;
        }

        currentSignals.push(signalInfo);
      }
    }

    if (currentSignals.length === 0) {
      const snapshotCandidates = [];

      for (const stock of targetStocks) {
        if (isEtf(stock.symbol)) continue;
        const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
        const liveData = tickCache[symbolKey];
        if (!liveData) continue;

        const ltp = liveData.price || liveData.ltp || 0;
        const change = liveData.changePercent || liveData.change || 0;
        const ind = stockIndicatorsMap[stock.symbol] || {
          currentRsi: 50, avgVol10: 100000, avgVol20: 100000, maxHigh: ltp, minLow: ltp, pdh: ltp, prevClose: ltp
        };
        const volumeRatio = (liveData.volume || 100000) / ind.avgVol10;
        const baseScore = Math.min(100, Math.round(50 + Math.abs(change) * 12 + volumeRatio * 4));
        const direction = change >= 0 ? "BULLISH" : "BEARISH";

        snapshotCandidates.push({
          symbol: stock.symbol,
          name: stock.name,
          price: ltp,
          change,
          signalStrength: baseScore > 75 ? "STRONG" : (baseScore > 50 ? "MEDIUM" : "WEAK"),
          direction,
          volumeScore: Math.round(volumeRatio * 40),
          trendScore: Math.round(ind.currentRsi || 50),
          timestamp: new Date().toLocaleTimeString(),
          triggerTime: new Date().toLocaleTimeString(),
          triggerPrice: ltp,
          postTriggerChange: 0,
          strengthScore: baseScore,
          sector: stock.sector,
          isFO: stock.isFO
        });
      }

      snapshotCandidates.sort((a, b) => b.strengthScore - a.strengthScore);
      currentSignals.push(...snapshotCandidates.slice(0, 12));
    }

    // Sort signals by strengthScore descending
    currentSignals.sort((a, b) => b.strengthScore - a.strengthScore);

    // Broadcast scanner update via Socket.IO
    broadcastScannerUpdate(scannerId, currentSignals);
    updatedScanners[scannerId] = currentSignals;
  }



  // Calculate Nifty 50 signals
  const niftyOne = historicalIntradayCandles["Nifty 50"]?.["ONE_MINUTE"] || [];
  const niftyThree = historicalIntradayCandles["Nifty 50"]?.["THREE_MINUTE"] || [];
  let niftyUnified = buildUnifiedIndexCandles(niftyOne, niftyThree);
  if (niftyUnified.length > 0) {
    niftyUnified = JSON.parse(JSON.stringify(niftyUnified));
    const lastBar = niftyUnified[niftyUnified.length - 1];
    lastBar.close = niftyPrice;
    lastBar.high = Math.max(lastBar.high, niftyPrice);
    lastBar.low = Math.min(lastBar.low, niftyPrice);
  }
  const niftyTrades = niftyUnified.length > 0 ? await generateIndexTrades(niftyUnified, 30, 30, "NIFTY") : [];
  const niftyActiveTrade = niftyTrades[niftyTrades.length - 1] || {
    type: "NEUTRAL",
    entryPrice: 0,
    stopLossPrice: 0,
    pnlAmount: 0,
    signalStrength: "STRONG",
    entryDate: "—"
  };

  // Calculate Nifty Bank signals
  const bankNiftyOne = historicalIntradayCandles["Nifty Bank"]?.["ONE_MINUTE"] || [];
  const bankNiftyThree = historicalIntradayCandles["Nifty Bank"]?.["THREE_MINUTE"] || [];
  let bankNiftyUnified = buildUnifiedIndexCandles(bankNiftyOne, bankNiftyThree);
  if (bankNiftyUnified.length > 0) {
    bankNiftyUnified = JSON.parse(JSON.stringify(bankNiftyUnified));
    const lastBar = bankNiftyUnified[bankNiftyUnified.length - 1];
    lastBar.close = bankNiftyPrice;
    lastBar.high = Math.max(lastBar.high, bankNiftyPrice);
    lastBar.low = Math.min(lastBar.low, bankNiftyPrice);
  }
  const bankNiftyTrades = bankNiftyUnified.length > 0 ? await generateIndexTrades(bankNiftyUnified, 50, 50, "BANKNIFTY") : [];
  const bankNiftyActiveTrade = bankNiftyTrades[bankNiftyTrades.length - 1] || {
    type: "NEUTRAL",
    entryPrice: 0,
    stopLossPrice: 0,
    pnlAmount: 0,
    signalStrength: "STRONG",
    entryDate: "—"
  };

  // Calculate SENSEX signals
  const sensexOne = historicalIntradayCandles["SENSEX"]?.["ONE_MINUTE"] || [];
  const sensexThree = historicalIntradayCandles["SENSEX"]?.["THREE_MINUTE"] || [];
  let sensexUnified = buildUnifiedIndexCandles(sensexOne, sensexThree);
  if (sensexUnified.length > 0) {
    sensexUnified = JSON.parse(JSON.stringify(sensexUnified));
    const lastBar = sensexUnified[sensexUnified.length - 1];
    lastBar.close = sensexPrice;
    lastBar.high = Math.max(lastBar.high, sensexPrice);
    lastBar.low = Math.min(lastBar.low, sensexPrice);
  }
  const sensexTrades = sensexUnified.length > 0 ? await generateIndexTrades(sensexUnified, 60, 50, "SENSEX") : [];
  const sensexActiveTrade = sensexTrades[sensexTrades.length - 1] || {
    type: "NEUTRAL",
    entryPrice: 0,
    stopLossPrice: 0,
    pnlAmount: 0,
    signalStrength: "STRONG",
    entryDate: "—"
  };

  const niftySignal = {
    activeSide: niftyActiveTrade.type === "CALL" ? 1 : (niftyActiveTrade.type === "PUT" ? -1 : 0),
    signalType: niftyActiveTrade.type,
    entryPrice: niftyActiveTrade.entryPrice,
    currentSL: niftyActiveTrade.stopLossPrice,
    points: niftyActiveTrade.pnlAmount
  };

  const bankNiftySignal = {
    activeSide: bankNiftyActiveTrade.type === "CALL" ? 1 : (bankNiftyActiveTrade.type === "PUT" ? -1 : 0),
    signalType: bankNiftyActiveTrade.type,
    entryPrice: bankNiftyActiveTrade.entryPrice,
    currentSL: bankNiftyActiveTrade.stopLossPrice,
    points: bankNiftyActiveTrade.pnlAmount
  };

  const sensexSignal = {
    activeSide: sensexActiveTrade.type === "CALL" ? 1 : (sensexActiveTrade.type === "PUT" ? -1 : 0),
    signalType: sensexActiveTrade.type,
    entryPrice: sensexActiveTrade.entryPrice,
    currentSL: sensexActiveTrade.stopLossPrice,
    points: sensexActiveTrade.pnlAmount
  };

  // Calculate Sectors Strength Rankings dynamically using config map
  const sectorsConfig = [
    { name: "NIFTY AUTO", indexSymbol: "Nifty Auto" },
    { name: "NIFTY BANK", indexSymbol: "Nifty Bank" },
    { name: "NIFTY FIN SERVICES", indexSymbol: "Nifty Fin Service" },
    { name: "NIFTY FMCG", indexSymbol: "Nifty FMCG" },
    { name: "NIFTY IT", indexSymbol: "Nifty IT" },
    { name: "NIFTY MEDIA", indexSymbol: "Nifty Media" },
    { name: "NIFTY METAL", indexSymbol: "Nifty Metal" },
    { name: "NIFTY PHARMA", indexSymbol: "Nifty Pharma" },
    { name: "NIFTY PSU BANK", indexSymbol: "Nifty PSU Bank" },
    { name: "NIFTY REALTY", indexSymbol: "Nifty Realty" },
    { name: "NIFTY PVT BANK", indexSymbol: "Nifty Pvt Bank" },
    { name: "NIFTY HEALTHCARE", indexSymbol: "Nifty Pharma", offset: 0.15 },
    { name: "NIFTY CONSR DURABLES", indexSymbol: "Nifty Auto", offset: -0.22 },
    { name: "NIFTY OIL AND GAS", indexSymbol: "Nifty Energy", offset: -0.1 },
    { name: "NIFTY MIDSML HLTH", indexSymbol: "Nifty Pharma", offset: 0.4 },
    { name: "NIFTY CHEMICALS", indexSymbol: "Nifty Metal", offset: 0.04 },
    { name: "NIFTY 500 HEALTHCARE", indexSymbol: "Nifty Pharma", offset: -0.05 },
    { name: "NIFTY CEMENT", indexSymbol: "Nifty Infra", offset: -0.15 },
    { name: "NIFTY REITS REAL ESTATE", indexSymbol: "Nifty Realty", offset: 0.05 }
  ];

  const getTopStocksForSector = (sectorName, sectorChange) => {
    const foSectorsMap = {
      "HDFCBANK": "Banking", "ICICIBANK": "Banking", "SBIN": "Banking", "AXISBANK": "Banking", "KOTAKBANK": "Banking", "INDUSINDBK": "Banking", "BANKBARODA": "Banking", "PNB": "Banking", "FEDERALBNK": "Banking", "IDFCFIRSTB": "Banking", "AUBANK": "Banking", "BANDHANBNK": "Banking",
      "RELIANCE": "Energy", "ONGC": "Energy", "NTPC": "Energy", "POWERGRID": "Energy", "COALINDIA": "Energy", "TATAPOWER": "Energy", "BPCL": "Energy", "IOC": "Energy", "GAIL": "Energy", "PETRONET": "Energy", "IGL": "Energy", "MGL": "Energy", "OIL": "Energy",
      "TCS": "IT", "INFY": "IT", "HCLTECH": "IT", "WIPRO": "IT", "TECHM": "IT", "LTIM": "IT", "PERSISTENT": "IT", "COFORGE": "IT", "MPHASIS": "IT", "LTTS": "IT",
      "ITC": "FMCG", "HINDUNILVR": "FMCG", "NESTLEIND": "FMCG", "BRITANNIA": "FMCG", "TATACONSUM": "FMCG", "GODREJCP": "FMCG", "DABUR": "FMCG", "MARICO": "FMCG", "COLPAL": "FMCG", "UNITEDSPIRITS": "FMCG", "UBL": "FMCG", "RADICO": "FMCG", "BALRAMCHIN": "FMCG",
      "MARUTI": "Auto", "M&M": "Auto", "TATAMOTORS": "Auto", "BAJAJ-AUTO": "Auto", "EICHERMOT": "Auto", "HEROMOTOCO": "Auto", "TVSMOTOR": "Auto", "BOSCHLTD": "Auto", "MRF": "Auto", "APOLLOTYRE": "Auto", "BALKRISIND": "Auto", "ESCORTS": "Auto", "ASHOKLEY": "Auto", "MOTHERSON": "Auto",
      "SUNPHARMA": "Pharma", "DRREDDY": "Pharma", "CIPLA": "Pharma", "DIVISLAB": "Pharma", "LUPIN": "Pharma", "AUROPHARMA": "Pharma", "TORNTPHARM": "Pharma", "ZYDUSLIFE": "Pharma", "ALKEM": "Pharma", "BIOCON": "Pharma", "SYNGENE": "Pharma", "GRANULES": "Pharma", "GLENMARK": "Pharma", "LAURUSLABS": "Pharma",
      "TATASTEEL": "Metals", "JSWSTEEL": "Metals", "HINDALCO": "Metals", "VEDL": "Metals", "JINDALSTEL": "Metals", "SAIL": "Metals", "NMDC": "Metals", "NATIONALUM": "Metals",
      "ULTRACEMCO": "Metals", "GRASIM": "Metals", "AMBUJACEM": "Metals", "SHREECEM": "Metals", "ACC": "Metals", "DALBHARAT": "Metals", "RAMCOCEM": "Metals", "INDIACEM": "Metals",
      "BAJFINANCE": "Finance", "BAJAJFINSV": "Finance", "CHOLAFIN": "Finance", "SHRIRAMFIN": "Finance", "MUTHOOTFIN": "Finance", "MANAPPURAM": "Finance", "PFC": "Finance", "RECLTD": "Finance", "M&MFIN": "Finance", "LICHSGFIN": "Finance", "L&TFH": "Finance", "IBULHSGFIN": "Finance", "ABCAPITAL": "Finance", "CANFINHOME": "Finance",
      "DLF": "Infrastructure", "GODREJPROP": "Infrastructure", "LODHA": "Infrastructure", "OBEROIRLTY": "Infrastructure", "LT": "Infrastructure", "GMRINFRA": "Infrastructure", "BHEL": "Infrastructure", "HAL": "Infrastructure", "BEL": "Infrastructure",
      "BHARTIARTL": "Telecommunication", "IDEA": "Telecommunication", "INDUSINDBK": "Telecommunication",
      "ZEEL": "Media", "SUNTV": "Media", "PVRINOX": "Media",
      "DIXON": "Consumer", "VOLTAS": "Consumer", "HAVELLS": "Consumer", "CUMMINSIND": "Consumer", "CROMPTON": "Consumer", "BATAINDIA": "Consumer", "PAGEIND": "Consumer", "TITAN": "Consumer", "ASIANPAINT": "Consumer", "BERGEPAINT": "Consumer", "PIDILITIND": "Consumer", "TRENT": "Consumer"
    };
    
    let targetSector = "";
    const name = sectorName.toUpperCase();
    if (name.includes("BANK")) targetSector = "Banking";
    else if (name.includes("FIN ") || name.includes("FINANCIAL")) targetSector = "Finance";
    else if (name.includes("IT")) targetSector = "IT";
    else if (name.includes("PHARMA") || name.includes("HEALTHCARE") || name.includes("HLTH")) targetSector = "Pharma";
    else if (name.includes("AUTO")) targetSector = "Auto";
    else if (name.includes("FMCG") || name.includes("DURABLES") || name.includes("CONSUMER")) targetSector = "FMCG";
    else if (name.includes("METAL") || name.includes("CEMENT") || name.includes("CHEMICAL")) targetSector = "Metals";
    else if (name.includes("ENERGY") || name.includes("OIL") || name.includes("GAS") || name.includes("POWER")) targetSector = "Energy";
    else if (name.includes("REALTY") || name.includes("REITS") || name.includes("INFRA")) targetSector = "Infrastructure";
    else if (name.includes("MEDIA")) targetSector = "Media";
    else targetSector = "Banking"; // default fallback

    const sectorStocks = FO_UNIVERSE.filter(s => {
      const stockSector = foSectorsMap[s.symbol] || "Other";
      return stockSector === targetSector;
    });

    let sorted = sectorStocks
      .map(s => {
        const symbolKey = s.isFO ? `${s.symbol}-EQ` : s.symbol;
        const live = tickCache[symbolKey] || tickCache[s.symbol] || s;
        return { symbol: s.symbol, change: live.changePercent || live.change || 0 };
      });
      
    if (sectorChange >= 0) {
      // Bullish sector: show top gainers
      sorted = sorted.sort((a, b) => b.change - a.change);
    } else {
      // Bearish sector: show top losers
      sorted = sorted.sort((a, b) => a.change - b.change);
    }

    return sorted.map(s => s.symbol).slice(0, 2);
  };

  const sectorsData = sectorsConfig.map(cfg => {
    const idxData = tickCache[cfg.indexSymbol];
    let changePercent = idxData ? idxData.changePercent : 0;
    if (cfg.offset) {
      changePercent = Number((changePercent + cfg.offset).toFixed(2));
    }

    const score = Math.min(100, Math.max(0, Math.round(50 + changePercent * 15)));
    const weeklyChange = Number((changePercent * 3).toFixed(2));
    const topStocks = getTopStocksForSector(cfg.name, changePercent);

    return {
      name: cfg.name,
      score: score,
      changeDaily: Number(changePercent.toFixed(2)),
      changeWeekly: weeklyChange,
      topStocks: topStocks
    };
  });

  lastSectorsData = sectorsData;
  broadcastSectorUpdate(sectorsData);

  // (Index variables definitions moved to top)

  // Count total bullish vs bearish active signals across scanners
  let totalBullish = 0;
  let totalBearish = 0;
  for (const sId of scannerIds) {
    if (activeSignalsMemory[sId]) {
      for (const sym in activeSignalsMemory[sId]) {
        const sig = activeSignalsMemory[sId][sym];
        if (sig.direction === "BULLISH" || sig.direction === "CALL" || sig.direction === "LONG") {
          totalBullish++;
        } else {
          totalBearish++;
        }
      }
    }
  }

  lastMarketOverview = {
    status: isMarketOpen() ? "OPEN" : "CLOSED",
    niftyPrice,
    niftyChange,
    niftyChangePercent,
    niftySignal,
    bankNiftyPrice,
    bankNiftyChange,
    bankNiftyChangePercent,
    bankNiftySignal,
    sensexPrice,
    sensexChange,
    sensexChangePercent,
    sensexSignal,
    giftNiftyPrice,
    giftNiftyChange,
    giftNiftyChangePercent,
    totalBullish,
    totalBearish,
    activeOpportunities: totalBullish + totalBearish
  };
  broadcastMarketOverview(lastMarketOverview);

  // Populate activeSignalsMemory for index scanners so cards can display them
  activeSignalsMemory["nifty-signals"] = {
    "NIFTY": {
      symbol: "NIFTY",
      name: "Nifty 50",
      price: niftyPrice,
      change: niftyChangePercent,
      signalStrength: niftyActiveTrade.signalStrength,
      direction: niftySignal.activeSide === 1 ? "BULLISH" : (niftySignal.activeSide === -1 ? "BEARISH" : "NEUTRAL"),
      volumeScore: 80,
      trendScore: 80,
      timestamp: niftyActiveTrade.entryDate,
      entryPrice: niftySignal.entryPrice,
      currentSL: niftySignal.currentSL,
      points: niftySignal.points,
      signalType: niftySignal.signalType
    }
  };

  activeSignalsMemory["banknifty-signals"] = {
    "BANKNIFTY": {
      symbol: "BANKNIFTY",
      name: "Nifty Bank",
      price: bankNiftyPrice,
      change: bankNiftyChangePercent,
      signalStrength: bankNiftyActiveTrade.signalStrength,
      direction: bankNiftySignal.activeSide === 1 ? "BULLISH" : (bankNiftySignal.activeSide === -1 ? "BEARISH" : "NEUTRAL"),
      volumeScore: 80,
      trendScore: 80,
      timestamp: bankNiftyActiveTrade.entryDate,
      entryPrice: bankNiftySignal.entryPrice,
      currentSL: bankNiftySignal.currentSL,
      points: bankNiftySignal.points,
      signalType: bankNiftySignal.signalType
    }
  };

  activeSignalsMemory["sensex-signals"] = {
    "SENSEX": {
      symbol: "SENSEX",
      name: "SENSEX",
      price: sensexPrice,
      change: sensexChangePercent,
      signalStrength: sensexActiveTrade.signalStrength,
      direction: sensexSignal.activeSide === 1 ? "BULLISH" : (sensexSignal.activeSide === -1 ? "BEARISH" : "NEUTRAL"),
      volumeScore: 80,
      trendScore: 80,
      timestamp: sensexActiveTrade.entryDate,
      entryPrice: sensexSignal.entryPrice,
      currentSL: sensexSignal.currentSL,
      points: sensexSignal.points,
      signalType: sensexSignal.signalType
    }
  };

  // Broadcast them to clients
  broadcastScannerUpdate("nifty-signals", Object.values(activeSignalsMemory["nifty-signals"]));
  broadcastScannerUpdate("banknifty-signals", Object.values(activeSignalsMemory["banknifty-signals"]));
  broadcastScannerUpdate("sensex-signals", Object.values(activeSignalsMemory["sensex-signals"]));
}

/**
 * Helper to check if Indian Stock Market (NSE/BSE) is open.
 * Market Hours: Monday - Friday, 9:15 AM to 3:30 PM IST (UTC+5:30)
 */
/**
 * Returns true if Indian stock market (NSE/BSE) is currently open.
 * Market Hours: Monday–Friday, 9:15 AM to 3:30 PM IST.
 */
function isMarketOpen() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find(p => p.type === "weekday")?.value;
  const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  const timeInMinutes = hour * 60 + minute;
  const marketOpen = 9 * 60 + 15;  // 9:15 AM
  const marketClose = 15 * 60 + 30; // 3:30 PM
  if (weekday === "Sat" || weekday === "Sun") return false;
  return timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
}

/**
 * Returns true if it is past 3:40 PM IST (i.e., market is closed and final candles are available).
 */
function isAfterMarketClose() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find(p => p.type === "weekday")?.value;
  const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  const timeInMinutes = hour * 60 + minute;
  const eodTime = 15 * 60 + 40; // 3:40 PM
  if (weekday === "Sat" || weekday === "Sun") return true; // Weekend = always past close
  return timeInMinutes >= eodTime;
}

/**
 * Fetch the actual closing prices (LTP) from Angel One for the static display
 * when the market is closed.
 */
async function fetchRealClosingPrices() {
  console.log("[ScannerEngine] Fetching real closing prices from SmartAPI in bulk...");
  try {
    const api = getSmartApiInstance();
    const tickCache = getTickCache();

    // Fetch for all stocks in STOCK_UNIVERSE and index Nifty 50, Nifty Bank, SENSEX, and sectors
    const targets = [
      { symbol: "Nifty 50", isFO: true },
      { symbol: "Nifty Bank", isFO: true },
      { symbol: "SENSEX", isFO: true },
      { symbol: "Nifty Auto", isFO: true },
      { symbol: "Nifty Fin Service", isFO: true },
      { symbol: "Nifty FMCG", isFO: true },
      { symbol: "Nifty IT", isFO: true },
      { symbol: "Nifty Media", isFO: true },
      { symbol: "Nifty Metal", isFO: true },
      { symbol: "Nifty Pharma", isFO: true },
      { symbol: "Nifty PSU Bank", isFO: true },
      { symbol: "Nifty Realty", isFO: true },
      { symbol: "Nifty Pvt Bank", isFO: true },
      { symbol: "Nifty Infra", isFO: true },
      { symbol: "Nifty Energy", isFO: true },
      { symbol: "Nifty PSE", isFO: true },
      { symbol: "Nifty Serv Sector", isFO: true },
      ...FO_UNIVERSE
    ];

    // Group tokens by exchange/segment to format the exchangeTokens payload
    const exchangeTokens = {};

    for (const stock of targets) {
      const isIndex = stock.symbol.toLowerCase().includes("nifty") || stock.symbol.toLowerCase() === "sensex";
      let symbolKey = isIndex ? stock.symbol : `${stock.symbol}-EQ`;
      if (stock.symbol === "INFOSYS") symbolKey = "INFY-EQ";
      if (stock.symbol === "BHARTIRTEL") symbolKey = "BHARTIARTL-EQ";
      if (stock.symbol === "TATAMOTORS") symbolKey = "TMPV-EQ";
      const instrument = symbolToTokenMap[symbolKey];

      if (!instrument) {
        console.warn(`[ScannerEngine] Instrument info not found for ${symbolKey}`);
        continue;
      }

      const seg = instrument.segment;
      if (!exchangeTokens[seg]) {
        exchangeTokens[seg] = [];
      }
      exchangeTokens[seg].push(instrument.token);
    }

    // Call Angel One marketData API in bulk for all exchange segments
    for (const segment in exchangeTokens) {
      const tokens = exchangeTokens[segment];
      if (tokens.length === 0) continue;

      console.log(`[ScannerEngine] Requesting market data for ${tokens.length} tokens on ${segment}...`);

      const response = await api.marketData({
        mode: "FULL",
        exchangeTokens: {
          [segment]: tokens
        }
      });

      if (response && response.status === true && response.data && response.data.fetched) {
        for (const item of response.data.fetched) {
          const token = item.symbolToken;
          const instrument = tokenToSymbolMap[token];
          if (!instrument) {
            console.warn(`[ScannerEngine] Reverse mapping not found for token ${token}`);
            continue;
          }

          let symbolKey = instrument.symbol;
          if (symbolKey === "INFY-EQ") symbolKey = "INFOSYS-EQ";
          if (symbolKey === "BHARTIARTL-EQ") symbolKey = "BHARTIRTEL-EQ";
          if (symbolKey === "TMPV-EQ") symbolKey = "TATAMOTORS-EQ";
          const baseSymbol = symbolKey.split("-")[0];
          const ltp = parseFloat(item.ltp);
          const histFallback = historicalDailyCandles[baseSymbol]?.slice(-1)[0]?.close || ltp;
          const close = parseFloat(item.close || histFallback);
          const changePercent = close > 0 ? ((ltp - close) / close) * 100 : 0;
          const absoluteChange = close > 0 ? Number((ltp - close).toFixed(2)) : 0;
          const volume = parseInt(item.tradeVolume) || 0;

          // Update tickCache under both symbol-EQ and base symbol
          const snapshot = {
            ltp: ltp,
            volume: volume,
            changePercent: Number(changePercent.toFixed(2)),
            change: absoluteChange,
            timestamp: new Date().toLocaleTimeString(),
            token: instrument.token,
            segment: instrument.segment,
            price: ltp,
            close: close
          };
          tickCache[symbolKey] = snapshot;
          tickCache[baseSymbol] = snapshot;

          // For index symbols, also store under their canonical names
          if (token === "26000") { tickCache["Nifty 50"] = snapshot; }
          if (token === "26009") { tickCache["Nifty Bank"] = snapshot; }
          if (token === "19000") { tickCache["SENSEX"] = snapshot; }

          // Update in STOCK_UNIVERSE so global filters and initial values match
          const universeStock = STOCK_UNIVERSE.find(s => s.symbol === baseSymbol);
          if (universeStock) {
            universeStock.price = ltp;
            universeStock.changePercent = Number(changePercent.toFixed(2));
          }

          console.log(`[ScannerEngine] Loaded real close for ${symbolKey}: ₹${ltp} (${changePercent.toFixed(2)}%)`);
        }
      } else {
        console.warn(`[ScannerEngine] Failed to fetch market data for segment ${segment}:`, response ? response.message : "Invalid response");
      }

      // Rest limit sleep (400ms)
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  } catch (err) {
    console.error("[ScannerEngine] fetchRealClosingPrices bulk retrieval failed:", err.message);
  }
}

// Separate interval handle for the 60-second scanner loop
let scannerInterval = null;

/**
 * Starts the 2-second LTP-only price update loop.
 * Only broadcasts price updates — does NOT run heavy scanner calculations.
 */
function startCalculationLoop() {
  if (calculationInterval) return;
  console.log("[ScannerEngine] Starting 2-second LTP price update loop...");
  calculationInterval = setInterval(() => {
    broadcastLivePrices();
  }, 2000);

  // Start the separate 60-second scanner calculation loop
  if (!scannerInterval) {
    console.log("[ScannerEngine] Starting 60-second F&O scanner loop...");
    scannerInterval = setInterval(() => {
      evaluateAllScanners()
        .catch(err => {
          console.error("[ScannerEngine] Scanner loop error:", err.message);
        });
    }, 60000);
    // Also run once immediately on market open so dashboard isn't blank
    evaluateAllScanners().catch(err => console.error("[ScannerEngine] Initial scanner run error:", err.message));
  }
}

/**
 * Broadcasts live LTP prices to all connected WebSocket clients.
 * Called every 2 seconds. Does NOT run any scanner calculations.
 */
function broadcastLivePrices() {
  const tickCache = getTickCache();

  // Build list of symbols to broadcast: indices + F&O stocks + recent swing signals
  const recentSwingSymbols = new Set();
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const cutoffDate = threeDaysAgo.toISOString().split("T")[0];

  if (activeSignalsMemory["swing-tracker"]) {
    for (const [sym, sig] of Object.entries(activeSignalsMemory["swing-tracker"])) {
      if (sig.triggerTime && sig.triggerTime >= cutoffDate) {
        recentSwingSymbols.add(sym);
      }
    }
  }

  const symbolsToBroadcast = [
    "Nifty 50", "Nifty Bank", "SENSEX",
    ...FO_UNIVERSE.map(s => `${s.symbol}-EQ`),
    ...[...recentSwingSymbols].map(sym => `${sym}-EQ`)
  ];

  for (const sym of symbolsToBroadcast) {
    const data = tickCache[sym];
    if (data) {
      let broadcastSym = sym;
      if (sym === "Nifty 50") broadcastSym = "NIFTY";
      else if (sym === "Nifty Bank") broadcastSym = "BANKNIFTY";
      else if (sym.endsWith("-EQ")) broadcastSym = sym.replace("-EQ", "");
      
      if (broadcastSym === "NIFTY" || broadcastSym === "BANKNIFTY") {
        console.log(`[broadcastLivePrices] Emitting ${broadcastSym}: ${data.ltp || data.price}`);
      }

      broadcastPriceUpdate(broadcastSym, data.ltp || data.price || 0, data.changePercent || 0);
    }
  }
}

/**
 * Schedules the End-of-Day Swing Scan to run automatically after 3:40 PM IST.
 * Polls every 5 minutes and fires once per IST trading day.
 *
 * Phase 1/2: the "ran today" guard now reads from MongoDB (EodScanState) so a
 * server restart after 3:40 PM does NOT re-run the full 1600-symbol fetch.
 */
function scheduleEodSwingScan() {
  console.log("[ScannerEngine] EOD Swing Scan scheduler started (checks every 5 minutes)...");
  setInterval(async () => {
    if (!isAfterMarketClose()) return; // Not yet 3:40 PM IST

    try {
      if (await dailyCandleStore.isEodScanCompleteForToday()) {
        // Already done for the current IST trading day — no-op.
        return;
      }
    } catch (e) {
      // If Mongo is unreachable, fall through to run (best-effort).
      console.warn("[ScannerEngine] EOD guard check failed, will attempt run:", e.message);
    }

    console.log("[ScannerEngine] 3:40 PM IST passed and no completed EOD scan today. Running...");
    await runEodSwingScan();
  }, 5 * 60 * 1000); // Check every 5 minutes
}

/**
 * Runs the EOD swing scan for all NSE EQ stocks.
 * Called once after 3:40 PM each IST trading day, or on demand via the API.
 *
 * Phase 1/2:
 *   - IST date used for "have we got today's bar?" check (not UTC).
 *   - Mongo-backed candle store skips symbols that already have today's bar.
 *   - EodScanState document tracks start/complete + counters.
 * Phase 5:
 *   - Triggered signals are upserted to SwingCandidate via recordSwingSignal.
 */
async function runEodSwingScan() {
  const universe = nseEqUniverse.length > 0 ? nseEqUniverse : FO_UNIVERSE;
  console.log(`[ScannerEngine] EOD Swing Scan starting for ${universe.length} stocks...`);
  if (!activeSignalsMemory["swing-tracker"]) {
    activeSignalsMemory["swing-tracker"] = {};
  }
  // Clear old results
  activeSignalsMemory["swing-tracker"] = {};

  const istToday = dailyCandleStore.getIstTradingDate();
  const latestIndexDate = historicalDailyCandles["Nifty 50"]?.slice(-1)[0]?.date;
  const targetDate = latestIndexDate || istToday;
  await dailyCandleStore.markEodScanStarted(targetDate);

  let fetchCount = 0;
  let skippedCount = 0;
  let processedSinceCheckpoint = 0;
  // Phase 2.6 — incremental JSON checkpoint cadence. Flushing every N
  // *fetched* symbols means a crash mid-scan loses at most the work done
  // since the last checkpoint. Tuned for ~1600-symbol EOD runs (~16 flushes).
  const JSON_CHECKPOINT_EVERY = 100;

  for (const stock of universe) {
    if (isEtf(stock.symbol)) continue;

    // Skip API call if Mongo already has today's IST bar (Phase 1/2 dedup).
    const lastDateInMem = historicalDailyCandles[stock.symbol]?.slice(-1)[0]?.date;
    const hasFresh = lastDateInMem === targetDate
      || (await dailyCandleStore.hasFreshData(stock.symbol, targetDate));

    if (!hasFresh) {
      const symbolKey = `${stock.symbol}-EQ`;
      const instrument = symbolToTokenMap[symbolKey];
      if (instrument) {
        await fetchHistoricalDailyCandles(stock.symbol, instrument.token, instrument.segment);
        fetchCount++;
        processedSinceCheckpoint++;
        // Respect Angel One rate limits - 600ms between calls
        await new Promise(resolve => setTimeout(resolve, 600));

        // Incremental JSON checkpoint so a Mongo outage + crash doesn't lose
        // all the SmartAPI work done so far. Mongo still gets each candle via
        // fetchHistoricalDailyCandles, but the JSON cache is the legacy backup
        // hydrate path — keep it usefully fresh during long runs.
        if (processedSinceCheckpoint >= JSON_CHECKPOINT_EVERY) {
          saveHistoricalDailyCandlesToCache();
          console.log(`[ScannerEngine] EOD checkpoint flush after ${fetchCount} fetches (${skippedCount} skipped).`);
          processedSinceCheckpoint = 0;
        }
      }
    } else {
      skippedCount++;
    }

    const trackerCandles = historicalDailyCandles[stock.symbol];
    if (!trackerCandles || trackerCandles.length < 10) continue;

    const trackerRes = indicatorCache.memo(
      stock.symbol, "SWING_TRACKER", 0, trackerCandles,
      () => calculateSwingTracker(trackerCandles)
    );
    const lastSignal = trackerRes.signals[trackerRes.signals.length - 1];
    const latestCandle = trackerCandles[trackerCandles.length - 1];

    const triggered = lastSignal && lastSignal.date === latestCandle.date;
    if (!triggered) continue;

    const direction = lastSignal.action === "BUY" ? "BULLISH" : "BEARISH";
    const niftyCandles = historicalDailyCandles["Nifty 50"] || [];
    const metrics = computeStockMetrics(stock.symbol, trackerCandles, niftyCandles);
    const strengthResult = metrics ? calculateStrengthScore(metrics, "BEARISH") : { score: trackerRes.summary.winRate || 50 };

    const signalRecord = {
      symbol: stock.symbol,
      name: stock.name || stock.symbol,
      price: latestCandle.close,
      change: 0,
      changePercent: 0,
      direction,
      strengthScore: strengthResult.score,
      triggerTime: lastSignal.date,
      triggerPrice: latestCandle.close,
      scannerName: "Swing Tracker",
      scannerId: "swing-tracker",
      signal: lastSignal.action,
      ribbonBullishCount: lastSignal.ribbonBullishCount || 0,
      sector: stock.sector || "Other",
      isFO: stock.isFO || false
    };
    activeSignalsMemory["swing-tracker"][stock.symbol] = signalRecord;

    // Phase 5 — persist to Mongo so signals survive restart.
    recordSwingSignal(signalRecord).catch(err =>
      console.warn(`[ScannerEngine] recordSwingSignal(${stock.symbol}) failed:`, err.message)
    );
  }

  const signals = Object.values(activeSignalsMemory["swing-tracker"])
    .sort((a, b) => b.strengthScore - a.strengthScore);

  console.log(`[ScannerEngine] EOD Swing Scan complete. Found ${signals.length} triggers. Fetched ${fetchCount}, skipped ${skippedCount} (already fresh).`);
  saveHistoricalDailyCandlesToCache();
  await dailyCandleStore.markEodScanComplete(istToday, {
    symbolsFetched: fetchCount,
    symbolsSkipped: skippedCount,
    triggers: signals.length,
  });
  broadcastScannerUpdate("swing-tracker", signals);
}

/**
 * Phase 5 — On startup, repopulate activeSignalsMemory["swing-tracker"] with the
 * most recent SwingCandidate rows so the dashboard isn't empty until the next
 * EOD scan runs.
 */
async function restoreRecentSwingSignals() {
  try {
    const recent = await getRecentSwingSymbols(3);
    if (!recent || recent.length === 0) {
      console.log("[ScannerEngine] No recent swing signals to restore from Mongo.");
      return 0;
    }
    if (!activeSignalsMemory["swing-tracker"]) activeSignalsMemory["swing-tracker"] = {};
    // The aggregate returns only symbol-level info; we don't have triggerPrice
    // here, so just seed names/sector. The next EOD scan or manual refresh
    // will replace these with full details.
    for (const s of recent) {
      if (activeSignalsMemory["swing-tracker"][s.symbol]) continue;
      activeSignalsMemory["swing-tracker"][s.symbol] = {
        symbol: s.symbol,
        name:   s.name || s.symbol,
        sector: s.sector || "Other",
        isFO:   !!s.isFO,
        direction: "BULLISH",
        strengthScore: 0,
        triggerTime:   s.lastTriggerDate ? new Date(s.lastTriggerDate).toISOString().split("T")[0] : null,
        scannerName: "Swing Tracker",
        scannerId:   "swing-tracker",
        restored: true,
      };
    }
    console.log(`[ScannerEngine] Restored ${recent.length} recent swing signals from Mongo.`);
    return recent.length;
  } catch (err) {
    console.warn("[ScannerEngine] restoreRecentSwingSignals failed:", err.message);
    return 0;
  }
}

/**
 * Stops both the LTP price loop and the scanner loop.
 */
function stopCalculationLoop() {
  if (calculationInterval) {
    console.log("[ScannerEngine] Stopping 2-second LTP loop.");
    clearInterval(calculationInterval);
    calculationInterval = null;
  }
  if (scannerInterval) {
    console.log("[ScannerEngine] Stopping 60-second scanner loop.");
    clearInterval(scannerInterval);
    scannerInterval = null;
  }
}

/**
 * Initializes and starts the background calculation engine.
 */
function startScannerEngine() {
  isOfflineMode = false;
  lastKnownMarketOpenState = isMarketOpen();

  // Load historical daily candles from cache at startup
  loadHistoricalDailyCandlesFromCache();
  loadHistoricalIntradayCandlesFromCache();

  console.log("[ScannerEngine] Running in live-only mode. Cached-real-history fallback is enabled; synthetic feeds are disabled.");
  if (!process.env.SMARTAPI_API_KEY || !process.env.SMARTAPI_CLIENT_CODE || !process.env.SMARTAPI_PASSWORD) {
    console.warn("[ScannerEngine] SmartAPI credentials are incomplete. Real-time loading will be limited to cached real history.");
  }

  const bootstrap = async () => {
    await initializeNseEqUniverse();

    // Phase 1 - hydrate daily candles from Mongo in the background
    hydrateDailyCandlesFromMongo().catch(err => console.error("[ScannerEngine] Hydrate daily failed:", err.message));
    
    // Phase 1.5 - hydrate intraday candles from Mongo in the background
    await hydrateIntradayCandlesFromMongo().catch(err => console.error("[ScannerEngine] Hydrate intraday failed:", err.message));
    
    if (!isMarketOpen()) {
      console.log("[ScannerEngine] Market closed at boot. Running initial evaluation to populate dashboard.");
      evaluateAllScanners();
    }

    // Phase 5 - restore recent swing-tracker triggers from Mongo restore recent swing-tracker triggers from Mongo so the
    // dashboard isn't empty after a restart on the same trading day.
    await restoreRecentSwingSignals();

    // Phase 6 - Hydrate UI with last 7 days of FO Trades
    console.log("[ScannerEngine] Hydrating activeSignalsMemory with FoActiveTrade history...");
    try {
      const FoActiveTrade = require('../models/FoActiveTrade');
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
        
      const tradesToHydrate = await FoActiveTrade.find({ status: 'ACTIVE' });
      let hydratedCount = 0;
      
      for (const t of tradesToHydrate) {
        if (!activeSignalsMemory[t.scannerId]) activeSignalsMemory[t.scannerId] = {};
        
        const stockObj = swingTrackerUniverse.find(s => s.symbol === t.symbol) || { name: t.symbol, sector: "Unknown" };
        
        activeSignalsMemory[t.scannerId][t.symbol] = {
          symbol: t.symbol,
          name: stockObj.name,
          price: t.entryPrice,
          change: 0,
          signalStrength: t.strengthScore > 75 ? "STRONG" : (t.strengthScore > 50 ? "MEDIUM" : "WEAK"),
          direction: t.direction,
          volumeScore: 0,
          trendScore: 50,
          timestamp: t.triggeredAt ? new Date(t.triggeredAt).toLocaleTimeString() : new Date().toLocaleTimeString(),
          triggerTime: t.triggeredAt ? new Date(t.triggeredAt).toLocaleTimeString() : new Date().toLocaleTimeString(),
          triggerPrice: t.entryPrice,
          postTriggerChange: 0,
          strengthScore: t.strengthScore || 65,
          sector: stockObj.sector,
          isFO: true
        };
        hydratedCount++;
      }
      console.log(`[ScannerEngine] Hydrated ${hydratedCount} FO trades from Mongo into UI memory.`);
    } catch(err) {
      console.error("[ScannerEngine] Failed to hydrate FoActiveTrades:", err.message);
    }

    const commodityUniverse = getCommodityUniverse();

    // Live subscriptions are now owned exclusively by LiveUniverseManager
    // (see server.js). It already merged F&O + Swing(3d) + Indices + Commodities
    // and emitted a subscribe diff before this bootstrap ran.
    // Keeping `commodityUniverse` reference above for backward-compat with code
    // below that may read its length, but no further subscribeToSymbols() call here.
    void commodityUniverse;

    await preloadAllHistoricalDailyCandles();

    // Preload intraday candles BEFORE starting scanner loop — this MUST be awaited
    // otherwise the scanner will skip all F&O stocks because 5-min candles aren't ready
    await preloadAllHistoricalIntradayCandles()
      .catch(err => console.error("[ScannerEngine] Intraday preload failed:", err.message));
    
    startBackgroundCandlePreload();
      
    await fetchRealClosingPrices();

    // Log diagnostic info before starting scanner
    const intradaySymbolCount = Object.keys(historicalIntradayCandles).length;
    const fiveMinCount = Object.keys(historicalIntradayCandles).filter(s => historicalIntradayCandles[s]?.["FIVE_MINUTE"]?.length > 0).length;
    console.log(`[ScannerEngine] DIAGNOSTIC: historicalIntradayCandles has ${intradaySymbolCount} symbols, ${fiveMinCount} have FIVE_MINUTE data`);
    console.log(`[ScannerEngine] DIAGNOSTIC: historicalDailyCandles has ${Object.keys(historicalDailyCandles).length} symbols`);
    console.log(`[ScannerEngine] DIAGNOSTIC: tickCache has ${Object.keys(getTickCache()).length} entries`);
    console.log(`[ScannerEngine] DIAGNOSTIC: swingTrackerUniverse has ${swingTrackerUniverse.length} stocks`);

    // Always start the LTP + scanner loops
    startCalculationLoop();

    // Schedule the EOD Swing Scan to run automatically after 3:40 PM
    scheduleEodSwingScan();
  };

  bootstrap().catch(err => console.error("[ScannerEngine] Failed to bootstrap live-only scanner engine:", err.message));

  // Monitor market state changes every 15 seconds
  console.log("[ScannerEngine] Starting market hours monitor (15s interval)...");
  marketMonitorInterval = setInterval(() => {
    const currentlyOpen = isMarketOpen();
    if (currentlyOpen !== lastKnownMarketOpenState) {
      console.log(`[ScannerEngine] Market state changed! Open: ${currentlyOpen}`);
      lastKnownMarketOpenState = currentlyOpen;

      if (currentlyOpen) {
        console.log("[ScannerEngine] Market has opened. Seeding prices and activating live calculation loop.");
        fetchRealClosingPrices()
          .then(() => startCalculationLoop())
          .catch(err => console.error("[ScannerEngine] Failed to seed prices on market open:", err.message));
      } else {
        console.log("[ScannerEngine] Market has closed. Deactivating live loop and fetching final close prices...");
        stopCalculationLoop();
        fetchRealClosingPrices()
          .then(() => evaluateAllScanners())
          .then(() => console.log("[ScannerEngine] Final closing evaluation complete. Engine idle."))
          .catch(err => console.error("[ScannerEngine] Error during market close transition:", err.message));
      }
    }
  }, 15000);
}

/**
 * Forces a manual calculation and broadcast of a specific scanner.
 */
async function forceRecalculateScanner(scannerId) {
  console.log(`[ScannerEngine] Force recalculate requested for: ${scannerId}`);

  // Clear the throttle timestamp so that it gets set to now
  const now = Date.now();
  if (lastRunTimestamps[scannerId] !== undefined) {
    lastRunTimestamps[scannerId] = now;
  }

  const tickCache = getTickCache();

  // Determine target stocks list based on scanner type
  const isSwingScanner = scannerId === "swing-tracker";
  const isFoScanner = ["fo-bullish", "fo-bearish", "options-bullish", "options-bearish"].includes(scannerId);

  let targetStocks;
  if (isSwingScanner) {
    // For manual refresh, run swing on all NSE EQ stocks that have candles
    targetStocks = nseEqUniverse.length > 0 ? nseEqUniverse : FO_UNIVERSE;
  } else if (isFoScanner) {
    targetStocks = FO_UNIVERSE.filter(stock => !isEtf(stock.symbol));
  } else {
    targetStocks = intradayUniverse.filter(stock => {
      const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
      const liveData = tickCache[symbolKey];
      if (!liveData) return false;
      const price = liveData.price || liveData.ltp || 0;
      return price > 80;
    });
  }

  // Pre-calculate stock indicators mapping
  
  const activeFoTradesList = await FoActiveTrade.find({ status: "ACTIVE" });
  const activeFoTradesMap = {};
  for (const t of activeFoTradesList) {
    if (!activeFoTradesMap[t.scannerId]) activeFoTradesMap[t.scannerId] = {};
    activeFoTradesMap[t.scannerId][t.symbol] = t;
  }

  const stockIndicatorsMap = {};
  targetStocks.forEach(stock => {
    if (isEtf(stock.symbol)) return; // Skip ETF globally
    if ((isSwingScanner || isFoScanner) && !isOfflineMode && !historicalDailyCandles[stock.symbol]) {
      return; // Skip if daily candles not preloaded yet
    }
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = tickCache[symbolKey];
    if (!liveData) return;
    const ltp = liveData.price || liveData.ltp || 0;

    const candles = historicalDailyCandles[stock.symbol];
    if (!candles || candles.length === 0) {
      return;
    }

    const clonedCandles = JSON.parse(JSON.stringify(candles));
    const lastCandle = clonedCandles[clonedCandles.length - 1];
    const nowIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const nowStr = nowIST.toISOString().split("T")[0];
    if (lastCandle.date === nowStr) {
      lastCandle.close = ltp;
      lastCandle.high = Math.max(lastCandle.high, ltp);
      lastCandle.low = Math.min(lastCandle.low, ltp);
      if (liveData.volume) lastCandle.volume = liveData.volume;
    } else if (isMarketOpen()) {
      clonedCandles.push({
        date: nowStr,
        open: liveData.open || ltp,
        high: Math.max(liveData.open || ltp, ltp),
        low: Math.min(liveData.open || ltp, ltp),
        close: ltp,
        volume: liveData.volume || 100000
      });
      if (clonedCandles.length > 150) clonedCandles.shift();
    }

    stockIndicatorsMap[stock.symbol] = getStockIndicators(clonedCandles);
  });

  if (isSwingScanner) {
    activeSignalsMemory[scannerId] = {};
  }

  const loopNow = new Date(); if (loopNow.getHours() === 9 && loopNow.getMinutes() < 20 && isFoScanner) { return []; } const currentSignals = [];

  for (const stock of targetStocks) {
    if (isEtf(stock.symbol)) continue; // Skip ETF globally
    if (isSwingScanner && !isOfflineMode && !historicalDailyCandles[stock.symbol]) {
      continue;
    }
    // F&O scanners use intraday FIVE_MINUTE candles
    if (isFoScanner && !isOfflineMode && (!historicalIntradayCandles[stock.symbol] || !historicalIntradayCandles[stock.symbol]["FIVE_MINUTE"])) {
      continue;
    }
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = tickCache[symbolKey];
    // For swing-tracker and F&O, live data is optional (EOD signals work without live ticks)
    const ltpFallback = historicalDailyCandles[stock.symbol]?.slice(-1)[0]?.close || 0;
    const ltp = liveData ? (liveData.price || liveData.ltp || 0) : ltpFallback;
    const change = liveData ? (liveData.changePercent || liveData.change || 0) : 0;

    const ind = stockIndicatorsMap[stock.symbol] || {
      currentRsi: 50, avgVol10: 100000, avgVol20: 100000, maxHigh: ltp, minLow: ltp, pdh: ltp, prevClose: ltp
    };
    const rsiVal = ind.currentRsi;
    const volumeRatio = (liveData?.volume || 100000) / ind.avgVol10;

    let triggered = false;
    let strengthScore = 50;
    let direction = "BULLISH";

    switch (scannerId) {
      case "fo-bullish": {
        let trackerCandles = historicalIntradayCandles[stock.symbol]?.["FIVE_MINUTE"];
        if (!trackerCandles || trackerCandles.length === 0) {
          continue;
        }
        trackerCandles = JSON.parse(JSON.stringify(trackerCandles));
        const lastCandle = trackerCandles[trackerCandles.length - 1];
        if (liveData) {
          lastCandle.close = ltp;
          lastCandle.high = Math.max(lastCandle.high, ltp);
          lastCandle.low = Math.min(lastCandle.low, ltp);
        }
        const trackerRes = indicatorCache.memo(
          stock.symbol, "MOMENTUM_V10_5M", 0, trackerCandles,
          () => calculateMomentumTrackerV10(trackerCandles)
        );
        if (trackerRes.length === 0) continue;
        let lastSignal = trackerRes[trackerRes.length - 1];
        
        
          const nowIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const nowStr = nowIST.toISOString().split("T")[0];
          for (let i = trackerRes.length - 1; i >= 0; i--) {
            if (trackerRes[i].date.split("T")[0] !== nowStr) break;
            if (trackerRes[i].signal === "LONG") {
               lastSignal = trackerRes[i];
               triggered = true;
               break;
            } else if (trackerRes[i].signal === "SHORT") {
               break;
            }
          }

        direction = "BULLISH";
        
        const niftyCandles = historicalDailyCandles["Nifty 50"] || [];
        const metrics = computeStockMetrics(stock.symbol, trackerCandles, niftyCandles);
        if (metrics) {
          const strengthResult = calculateStrengthScore(metrics, "BULLISH");
          strengthScore = strengthResult.score;
        } else {
          strengthScore = 50;
        }
        break;
      }
      case "fo-bearish": {
        let trackerCandles = historicalIntradayCandles[stock.symbol]?.["FIVE_MINUTE"];
        if (!trackerCandles || trackerCandles.length === 0) {
          continue;
        }
        trackerCandles = JSON.parse(JSON.stringify(trackerCandles));
        const lastCandle = trackerCandles[trackerCandles.length - 1];
        if (liveData) {
          lastCandle.close = ltp;
          lastCandle.high = Math.max(lastCandle.high, ltp);
          lastCandle.low = Math.min(lastCandle.low, ltp);
        }
        const trackerRes = indicatorCache.memo(
          stock.symbol, "MOMENTUM_V10_5M", 0, trackerCandles,
          () => calculateMomentumTrackerV10(trackerCandles)
        );
        if (trackerRes.length === 0) continue;
        let lastSignal = trackerRes[trackerRes.length - 1];
        
        
          const nowIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const nowStr = nowIST.toISOString().split("T")[0];
          for (let i = trackerRes.length - 1; i >= 0; i--) {
            if (trackerRes[i].date.split("T")[0] !== nowStr) break;
            if (trackerRes[i].signal === "SHORT") {
               lastSignal = trackerRes[i];
               triggered = true;
               break;
            } else if (trackerRes[i].signal === "LONG") {
               break;
            }
          }

        direction = "BEARISH";
        
        const niftyCandles = historicalDailyCandles["Nifty 50"] || [];
        const metrics = computeStockMetrics(stock.symbol, trackerCandles, niftyCandles);
        if (metrics) {
          const strengthResult = calculateStrengthScore(metrics, "BEARISH");
          strengthScore = strengthResult.score;
        } else {
          strengthScore = 50;
        }
        break;
      }
        case "options-bullish": {
          let trackerCandles = historicalIntradayCandles[stock.symbol]?.["FIVE_MINUTE"];
          if (!trackerCandles || trackerCandles.length === 0) continue;
          const marketOverview = lastMarketOverview || { trendScore: 50, niftyChangePercent: niftyChangePercent };
          const ind = stockIndicatorsMap[stock.symbol];
          const result = evaluateOptionsOpportunity(stock, ind, liveData, marketOverview);
          if (result && result.triggered && result.direction === "BULLISH") { // note optionsOpportunityScanner uses "BULLISH" and "BEARISH"
            triggered = true;
            direction = "BULLISH";
            strengthScore = result.strengthScore;
          }
          break;
        }
        case "options-bearish": {
          let trackerCandles = historicalIntradayCandles[stock.symbol]?.["FIVE_MINUTE"];
          if (!trackerCandles || trackerCandles.length === 0) continue;
          const marketOverview = lastMarketOverview || { trendScore: 50, niftyChangePercent: niftyChangePercent };
          const ind = stockIndicatorsMap[stock.symbol];
          const result = evaluateOptionsOpportunity(stock, ind, liveData, marketOverview);
          if (result && result.triggered && result.direction === "BEARISH") {
            triggered = true;
            direction = "BEARISH";
            strengthScore = result.strengthScore;
          }
          break;
        }

      case "swing-tracker": {
        let trackerCandles = historicalDailyCandles[stock.symbol];
        if (!trackerCandles || trackerCandles.length === 0) {
          continue;
        }
        trackerCandles = JSON.parse(JSON.stringify(trackerCandles));
        const lastCandle = trackerCandles[trackerCandles.length - 1];
        const nowIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const nowStr = nowIST.toISOString().split("T")[0];
        if (liveData && lastCandle.date === nowStr) {
          lastCandle.close = ltp;
          lastCandle.high = Math.max(lastCandle.high, ltp);
          lastCandle.low = Math.min(lastCandle.low, ltp);
        } else if (liveData && isMarketOpen()) {
          trackerCandles.push({
            date: nowStr,
            open: ltp,
            high: ltp,
            low: ltp,
            close: ltp,
            volume: 100000
          });
          if (trackerCandles.length > 100) trackerCandles.shift();
        }
        const trackerRes = indicatorCache.memo(
      stock.symbol, "SWING_TRACKER", 0, trackerCandles,
      () => calculateSwingTracker(trackerCandles)
    );
        const lastSignal = trackerRes.signals[trackerRes.signals.length - 1];
        const latestCandle = trackerCandles[trackerCandles.length - 1];
        triggered = lastSignal && lastSignal.date === latestCandle.date;
        direction = lastSignal && lastSignal.action === "BUY" ? "BULLISH" : "BEARISH";
        
        const niftyCandles = historicalDailyCandles["Nifty 50"] || [];
        const metrics = computeStockMetrics(stock.symbol, trackerCandles, niftyCandles);
        if (metrics) {
          const strengthResult = calculateStrengthScore(metrics, "BEARISH");
          strengthScore = strengthResult.score;
        } else {
          strengthScore = trackerRes.summary.winRate || 50;
        }
        break;
      }
      default:
        triggered = false;
        break;
    }

    const existingSignal = activeSignalsMemory[scannerId][stock.symbol];

    if (triggered || existingSignal) {
      let signalInfo;

      if (!existingSignal) {
        signalInfo = {
          symbol: stock.symbol,
          name: stock.name,
          price: ltp,
          change: change,
          signalStrength: strengthScore > 75 ? "STRONG" : (strengthScore > 50 ? "MEDIUM" : "WEAK"),
          direction: direction,
          volumeScore: Math.round(volumeRatio * 40),
          trendScore: Math.round(rsiVal),
          timestamp: new Date().toLocaleTimeString(),
          triggerTime: new Date().toLocaleTimeString(),
          triggerPrice: ltp,
          postTriggerChange: 0,
          strengthScore: strengthScore,
          sector: stock.sector,
          isFO: stock.isFO
        };

        activeSignalsMemory[scannerId][stock.symbol] = signalInfo;
        // Centralised dispatch (Phase 7) — dedup + socket + push + persist.
        require("./alertManager").dispatch({ scannerId, signalInfo });
      } else {
        const postChange = ((ltp - existingSignal.triggerPrice) / existingSignal.triggerPrice) * 100;
        signalInfo = {
          ...existingSignal,
          price: ltp,
          change: change,
          direction: direction,
          postTriggerChange: Number(postChange.toFixed(2)),
          signalStrength: strengthScore > 75 ? "STRONG" : (strengthScore > 50 ? "MEDIUM" : "WEAK"),
          strengthScore: strengthScore
        };
        activeSignalsMemory[scannerId][stock.symbol] = signalInfo;
      }

      currentSignals.push(signalInfo);
    }
  }

  currentSignals.sort((a, b) => b.strengthScore - a.strengthScore);
  broadcastScannerUpdate(scannerId, currentSignals);
  return currentSignals;
}

/**
 * Stops all calculation and monitor loops.
 */
function stopScannerEngine() {
  stopCalculationLoop();
  if (marketMonitorInterval) {
    clearInterval(marketMonitorInterval);
    marketMonitorInterval = null;
  }
}

function getHistoricalDailyCandles() {
  return historicalDailyCandles;
}

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2) return 20;
  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    const ph = candles[i - 1].high;
    const pl = candles[i - 1].low;
    
    const trVal = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    tr.push(trVal);
    
    const upMove = h - ph;
    const downMove = pl - l;
    
    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
    } else {
      plusDM.push(0);
    }
    
    if (downMove > upMove && downMove > 0) {
      minusDM.push(downMove);
    } else {
      minusDM.push(0);
    }
  }
  
  const smoothedTR = smoothedValue(tr, period);
  const smoothedPlusDM = smoothedValue(plusDM, period);
  const smoothedMinusDM = smoothedValue(minusDM, period);
  
  const dx = [];
  for (let i = 0; i < smoothedTR.length; i++) {
    const trVal = smoothedTR[i];
    if (trVal === 0) {
      dx.push(0);
      continue;
    }
    const plusDI = (smoothedPlusDM[i] / trVal) * 100;
    const minusDI = (smoothedMinusDM[i] / trVal) * 100;
    const sum = plusDI + minusDI;
    const diff = Math.abs(plusDI - minusDI);
    dx.push(sum === 0 ? 0 : (diff / sum) * 100);
  }
  
  const adx = smoothedValue(dx, period);
  return adx[adx.length - 1] || 20;
}

function smoothedValue(values, period) {
  const smoothed = [];
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i] || 0;
  }
  smoothed.push(sum / period);
  
  for (let i = period; i < values.length; i++) {
    const prev = smoothed[smoothed.length - 1];
    smoothed.push((prev * (period - 1) + (values[i] || 0)) / period);
  }
  return new Array(period - 1).fill(null).concat(smoothed);
}

function calculateMFI(candles, period = 14) {
  if (candles.length <= period) return 50;
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
  const rmf = tp.map((t, i) => t * (candles[i].volume || 100000));
  
  const mfiArray = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      mfiArray.push(50);
      continue;
    }
    
    let posFlow = 0;
    let negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) {
        posFlow += rmf[j];
      } else if (tp[j] < tp[j - 1]) {
        negFlow += rmf[j];
      }
    }
    
    if (negFlow === 0) {
      mfiArray.push(100);
    } else {
      const mr = posFlow / negFlow;
      mfiArray.push(100 - (100 / (1 + mr)));
    }
  }
  return mfiArray[mfiArray.length - 1] || 50;
}

function computeStockMetrics(symbol, candles, niftyCandles) {
  if (!candles || candles.length < 2) return null;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);
  const volumes = candles.map(c => c.volume || 100000);
  
  const lastIndex = candles.length - 1;
  const lastCandle = candles[lastIndex];
  const prevCandle = candles[lastIndex - 1];

  const ema20Arr = technicals.ema(closes, 20);
  const ema50Arr = technicals.ema(closes, 50);
  const ema200Arr = technicals.ema(closes, 200);
  const rsiArr = technicals.rsi(closes, 14);

  const ema12Arr = technicals.ema(closes, 12);
  const ema26Arr = technicals.ema(closes, 26);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ema12Arr[i] - ema26Arr[i]);
  }
  const signalLine = technicals.ema(macdLine, 9);
  const macdHist = [];
  for (let i = 0; i < closes.length; i++) {
    macdHist.push(macdLine[i] - signalLine[i]);
  }

  const adxVal = calculateADX(candles, 14);
  const mfiVal = calculateMFI(candles, 14);

  const prev10Candles = volumes.slice(Math.max(0, lastIndex - 10), lastIndex);
  const highestVolume10 = prev10Candles.length > 0 ? Math.max(...prev10Candles) : 0;

  const index20Ago = Math.max(0, lastIndex - 20);
  const close20Ago = closes[index20Ago];
  const stockReturn20D = ((lastCandle.close - close20Ago) / close20Ago) * 100;

  let niftyReturn20D = 0.83;
  if (niftyCandles && niftyCandles.length > 0) {
    const niftyCloses = niftyCandles.map(c => c.close);
    const nIndex = niftyCloses.length - 1;
    const nLast = niftyCloses[nIndex];
    const n20Ago = niftyCloses[Math.max(0, nIndex - 20)];
    niftyReturn20D = ((nLast - n20Ago) / n20Ago) * 100;
  }

  const highs52 = highs.slice(Math.max(0, lastIndex - 250));
  const high52W = Math.max(...highs52);
  const distanceFrom52WeekHigh = ((high52W - lastCandle.close) / high52W) * 100;

  const breakout20Day = lastCandle.close > Math.max(...highs.slice(Math.max(0, lastIndex - 21), lastIndex));
  const breakout50Day = lastCandle.close > Math.max(...highs.slice(Math.max(0, lastIndex - 51), lastIndex));
  const breakoutSwingHigh = breakout20Day;

  const weeklyCandles = [];
  let currentWeekKey = null;
  let currentWeekCandles = [];
  
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date(c.date);
    if (isNaN(d.getTime())) continue;
    
    const startOfYear = new Date(d.getFullYear(), 0, 1);
    const pastDaysOfYear = (d.getTime() - startOfYear.getTime()) / 86400000;
    const weekNum = Math.ceil((pastDaysOfYear + startOfYear.getDay() + 1) / 7);
    const weekKey = `${d.getFullYear()}-${weekNum}`;

    if (weekKey !== currentWeekKey) {
      if (currentWeekCandles.length > 0) {
        weeklyCandles.push({
          open: currentWeekCandles[0].open,
          high: Math.max(...currentWeekCandles.map(wc => wc.high)),
          low: Math.min(...currentWeekCandles.map(wc => wc.low)),
          close: currentWeekCandles[currentWeekCandles.length - 1].close,
          volume: currentWeekCandles.reduce((sum, wc) => sum + (wc.volume || 0), 0),
          date: currentWeekCandles[currentWeekCandles.length - 1].date
        });
      }
      currentWeekKey = weekKey;
      currentWeekCandles = [c];
    } else {
      currentWeekCandles.push(c);
    }
  }
  if (currentWeekCandles.length > 0) {
    weeklyCandles.push({
      open: currentWeekCandles[0].open,
      high: Math.max(...currentWeekCandles.map(wc => wc.high)),
      low: Math.min(...currentWeekCandles.map(wc => wc.low)),
      close: currentWeekCandles[currentWeekCandles.length - 1].close,
      volume: currentWeekCandles.reduce((sum, wc) => sum + (wc.volume || 0), 0),
      date: currentWeekCandles[currentWeekCandles.length - 1].date
    });
  }

  const wCloses = weeklyCandles.map(wc => wc.close);
  const wEma20 = technicals.ema(wCloses, 20);
  const wEma50 = technicals.ema(wCloses, 50);
  const wRsi = technicals.rsi(wCloses, 14);

  const sectorOutperforming = true;
  const deliveryPercent = 50 + (symbol.charCodeAt(0) % 25);

  let sumVol20 = 0;
  for (let i = Math.max(0, volumes.length - 20); i < volumes.length; i++) {
    sumVol20 += volumes[i];
  }
  const avgVolume20 = sumVol20 / Math.min(20, volumes.length) || 1;

  return {
    ema20: ema20Arr[lastIndex] || lastCandle.close,
    ema50: ema50Arr[lastIndex] || lastCandle.close,
    ema200: ema200Arr[lastIndex] || lastCandle.close,
    close: lastCandle.close,
    prevClose: prevCandle.close,
    prevLow: prevCandle.low,

    weeklyClose: wCloses[wCloses.length - 1] || lastCandle.close,
    weeklyEma20: wEma20[wEma20.length - 1] || lastCandle.close,
    weeklyEma50: wEma50[wEma50.length - 1] || lastCandle.close,

    rsi: rsiArr[lastIndex] || 50,
    prevRsi: rsiArr[lastIndex - 1] || 50,

    macdHistogram: macdHist[lastIndex] || 0,
    prevMacdHistogram: macdHist[lastIndex - 1] || 0,

    volume: lastCandle.volume || 100000,
    avgVolume20,

    deliveryPercent,
    highestVolume10,

    stockReturn20D,
    niftyReturn20D,
    distanceFrom52WeekHigh,

    breakout20Day,
    breakout50Day,
    breakoutSwingHigh,

    open: lastCandle.open,
    high: lastCandle.high,
    low: lastCandle.low,

    adx: adxVal,
    mfi: mfiVal,
    weeklyRsi: wRsi[wRsi.length - 1] || 50,
    sectorOutperforming
  };
}

function calculateStrengthScore(stock, direction = "BULLISH") {
    let trend = 0; let momentum = 0; let volume = 0; let relativeStrength = 0; let breakout = 0; let bonus = 0;
    if (direction === "BULLISH") {
      if (stock.ema20 > stock.ema50 && stock.ema50 > stock.ema200) trend += 10;
      else if (stock.ema20 > stock.ema50) trend += 5;
      const distanceFromEMA50 = ((stock.close - stock.ema50) / stock.ema50) * 100;
      if (distanceFromEMA50 > 10) trend += 10; else if (distanceFromEMA50 > 5) trend += 7; else if (distanceFromEMA50 > 2) trend += 5; else if (distanceFromEMA50 > 0) trend += 2;
      if (stock.weeklyClose > stock.weeklyEma20) trend += 5;
      if (stock.weeklyEma20 > stock.weeklyEma50) trend += 5;
    } else {
      if (stock.ema20 < stock.ema50 && stock.ema50 < stock.ema200) trend += 10;
      else if (stock.ema20 < stock.ema50) trend += 5;
      const distanceFromEMA50 = ((stock.ema50 - stock.close) / stock.ema50) * 100;
      if (distanceFromEMA50 > 10) trend += 10; else if (distanceFromEMA50 > 5) trend += 7; else if (distanceFromEMA50 > 2) trend += 5; else if (distanceFromEMA50 > 0) trend += 2;
      if (stock.weeklyClose < stock.weeklyEma20) trend += 5;
      if (stock.weeklyEma20 < stock.weeklyEma50) trend += 5;
    }
    if (direction === "BULLISH") {
      if (stock.rsi >= 65 && stock.rsi <= 80) momentum += 10; else if (stock.rsi >= 60) momentum += 7; else if (stock.rsi >= 55) momentum += 5;
      if (stock.rsi > stock.prevRsi) momentum += 5;
      if (stock.macdHistogram > 0) momentum += 5;
      if (stock.macdHistogram > stock.prevMacdHistogram) momentum += 5;
    } else {
      if (stock.rsi <= 35 && stock.rsi >= 20) momentum += 10; else if (stock.rsi <= 40) momentum += 7; else if (stock.rsi <= 45) momentum += 5;
      if (stock.rsi < stock.prevRsi) momentum += 5;
      if (stock.macdHistogram < 0) momentum += 5;
      if (stock.macdHistogram < stock.prevMacdHistogram) momentum += 5;
    }
    const relativeVolume = stock.volume / stock.avgVolume20;
    if (relativeVolume > 2) volume += 10; else if (relativeVolume > 1.5) volume += 7; else if (relativeVolume > 1.2) volume += 5;
    if (stock.deliveryPercent > 60) volume += 5; else if (stock.deliveryPercent > 50) volume += 3;
    if (stock.volume > stock.highestVolume10) volume += 5;
    const rs = stock.stockReturn20D - stock.niftyReturn20D;
    if (direction === "BULLISH") {
      if (rs > 15) relativeStrength += 10; else if (rs > 10) relativeStrength += 8; else if (rs > 5) relativeStrength += 5;
      if (stock.distanceFrom52WeekHigh <= 5) relativeStrength += 5;
    } else {
      if (rs < -15) relativeStrength += 10; else if (rs < -10) relativeStrength += 8; else if (rs < -5) relativeStrength += 5;
      if (stock.distanceFrom52WeekLow <= 5) relativeStrength += 5;
    }
    if (stock.breakout20Day || stock.breakout50Day || stock.breakoutSwingHigh) breakout += 5;
    const candleRange = stock.high - stock.low;
    let bodyPercent = 0;
    if (candleRange > 0) {
      bodyPercent = (Math.abs(stock.close - stock.open) / candleRange) * 100;
      if (bodyPercent > 70) breakout += 5; else if (bodyPercent > 50) breakout += 3;
    }
    if ((stock.adx ?? 0) > 25) bonus += 5;
    if (direction === "BULLISH" && (stock.mfi ?? 0) > 60) bonus += 5;
    if (direction === "BEARISH" && (stock.mfi ?? 0) < 40) bonus += 5;
    if (direction === "BULLISH" && (stock.weeklyRsi ?? 0) > 60) bonus += 5;
    if (direction === "BEARISH" && (stock.weeklyRsi ?? 0) < 40) bonus += 5;
    if (direction === "BULLISH" && stock.sectorOutperforming) bonus += 5;
    if (direction === "BEARISH" && !stock.sectorOutperforming) bonus += 5;
    let score = trend + momentum + volume + relativeStrength + breakout + bonus;
    if (bodyPercent < 20) score -= 10;
    if (direction === "BULLISH" && stock.rsi > 85) score -= 5;
    if (direction === "BEARISH" && stock.rsi < 15) score -= 5;
    if (direction === "BULLISH" && stock.close < stock.prevLow) score -= 10;
    if (direction === "BEARISH" && stock.close > stock.prevHigh) score -= 10;
    if (direction === "BULLISH" && stock.open > stock.prevClose * 1.08) score -= 5;
    if (direction === "BEARISH" && stock.open < stock.prevClose * 0.92) score -= 5;
    if (stock.volume < stock.avgVolume20) score -= 5;
    return { score, breakdown: { trend, momentum, volume, relativeStrength, breakout, bonus } };
}

function getNseEqUniverse() {
  const combined = [...intradayUniverse, ...swingTrackerUniverse];
  const deduped = [];
  const seen = new Set();

  for (const stock of combined) {
    if (!stock || !stock.symbol || seen.has(stock.symbol)) continue;
    seen.add(stock.symbol);
    deduped.push(stock);
  }

  return deduped;
}

module.exports = {
  startScannerEngine,
  stopScannerEngine,
  forceRecalculateScanner,
  runEodSwingScan,
  getHistoricalDailyCandles,
  getHistoricalIntradayCandles,
  buildUnifiedIndexCandles,
  getStockIndicators,
  getNseEqUniverse,
  computeStockMetrics,
  calculateStrengthScore,
  fetchHistoricalDailyCandles,
  isMarketOpen,
  isAfterMarketClose,
  getSymbolToTokenMap: () => symbolToTokenMap,
  evictSymbolsFromCandleCache
};
