const fs = require("fs");
const path = require("path");
const { getTickCache, symbolToTokenMap, tokenToSymbolMap, loadScripMaster } = require("./marketDataFeed");
const { calculateHullSignals, generateIndexTrades } = require("./hullScanner");
const { calculateSwingTracker } = require("./swingTracker");
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
const { sendPushToUsers } = require("../utils/onesignal");

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

// Active Trigger Memory (Sticky Signals)
// Structure: { [scannerId]: { [symbol]: { triggerTime, triggerPrice, ... } } }
let activeSignalsMemory = {};

// In-memory cache for real daily historical candles from SmartAPI
let historicalDailyCandles = {};
let historicalIntradayCandles = {};

const candlesCachePath = path.join(__dirname, "../config/historicalDailyCandles.json");
const intradayCandlesCachePath = path.join(__dirname, "../config/historicalIntradayCandles.json");

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
      historicalIntradayCandles = JSON.parse(fs.readFileSync(intradayCandlesCachePath, "utf-8"));
      console.log(`[ScannerEngine] Loaded ${Object.keys(historicalIntradayCandles).length} indices historical intraday candles from local cache.`);
      return true;
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
      historicalDailyCandles = JSON.parse(fs.readFileSync(candlesCachePath, "utf-8"));
      console.log(`[ScannerEngine] Loaded ${Object.keys(historicalDailyCandles).length} stocks historical candles from local cache.`);
      return true;
    }
  } catch (err) {
    console.error("[ScannerEngine] Failed to load candles from cache:", err.message);
  }
  return false;
}

// Global caches for synchronizing new socket clients instantly
let lastSectorsData = null;
let lastMarketOverview = null;

const scannerIds = [
  "bullish-intraday", "bearish-intraday", "options-opportunities", "swing-trades",
  "soon-breakouts", "52week-high", "52week-low", "range-breakouts", "volume-explosions",
  "rs-leaders", "rs-weakness", "ema-scans", "momentum-leaders", "high-delivery",
  "fo-active", "daily-breakouts", "gap-up", "gap-down", "swing-momentum-breakout",
  "top-gainers", "top-losers", "swing-tracker", "early-swing-reversal", "institutional-accumulation",
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
  "swing-tracker": 0,
  "early-swing-reversal": 0,
  "swing-trades": 0,
  "swing-momentum-breakout": 0
};

// Background loops
let calculationInterval = null;
let offlineMockInterval = null;
let marketMonitorInterval = null;
let isOfflineMode = true;
let lastKnownMarketOpenState = null;

/**
 * Helper to format date as "YYYY-MM-DD HH:MM"
 */
function formatSmartApiDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 09:15`;
}

/**
 * Fetches real historical daily candles for a specific token from SmartAPI and caches them.
 */
async function fetchHistoricalDailyCandles(symbolKey, token, segment) {
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

      if (response && response.status === true && response.data && response.data.length > 0) {
        const candles = response.data.map(c => ({
          date: c[0].split("T")[0],
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseInt(c[5]) || 100000
        }));
        historicalDailyCandles[symbolKey] = candles;
        console.log(`[ScannerEngine] Cached ${candles.length} real daily candles for ${symbolKey}.`);
        return true;
      } else {
        console.warn(`[ScannerEngine] Empty or invalid daily candles response for ${symbolKey}:`, response ? response.message : "No response");
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
        console.log(`[ScannerEngine] Loaded ${nseEqUniverse.length} stocks from cache.`);
        return;
      }
    } catch (err) {
      console.warn("[ScannerEngine] Failed to load NSE EQ universe cache:", err.message);
    }
  }

  if (isOfflineMode) {
    console.log("[ScannerEngine] Offline mode: Seeding mock NSE EQ universe...");
    const mockSectors = ["IT", "Banking", "Auto", "FMCG", "Metals", "Pharma", "Energy"];
    const mockList = [];
    for (let i = 1; i <= 150; i++) {
      const symbol = `MOCKSTOCK${i}`;
      mockList.push({
        symbol,
        name: `Mock Stock India ${i} Ltd.`,
        price: 80 + (i * 12) % 400,
        sector: mockSectors[i % mockSectors.length],
        isFO: i % 5 === 0
      });
    }
    nseEqUniverse = mockList;
    
    // Ensure config directory exists
    const dir = path.dirname(localCachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(localCachePath, JSON.stringify(nseEqUniverse, null, 2));
    console.log(`[ScannerEngine] Seeded and cached ${nseEqUniverse.length} mock stocks.`);
    return;
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
    
    // Ensure config directory exists
    const dir = path.dirname(localCachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(localCachePath, JSON.stringify(nseEqUniverse, null, 2));
    console.log(`[ScannerEngine] Mapped and cached ${nseEqUniverse.length} NSE EQ stocks with price > 75.`);
  } catch (err) {
    console.error("[ScannerEngine] Failed to initialize NSE EQ universe:", err.message);
    nseEqUniverse = STOCK_UNIVERSE.map(s => ({ ...s }));
  }
}

/**
 * Starts background daily candle preloader for NSE EQ universe.
 */
async function startBackgroundCandlePreload() {
  if (isBackgroundPreloading) return;
  isBackgroundPreloading = true;
  backgroundPreloadIndex = 0;

  if (isOfflineMode) {
    console.log("[ScannerEngine] Offline mode: Seeding background candles for NSE EQ universe...");
    nseEqUniverse.forEach(stock => {
      if (!historicalDailyCandles[stock.symbol]) {
        historicalDailyCandles[stock.symbol] = generateMockCandles(stock.symbol, stock.price, 150);
      }
    });
    console.log("[ScannerEngine] Seeding background candles complete.");
    isBackgroundPreloading = false;
    return;
  }

  console.log(`[ScannerEngine] Starting background daily candle preload for ${nseEqUniverse.length} stocks...`);

  async function loadNext() {
    if (backgroundPreloadIndex >= nseEqUniverse.length) {
      console.log("[ScannerEngine] Background daily candle preload complete for all NSE EQ universe.");
      isBackgroundPreloading = false;
      saveHistoricalDailyCandlesToCache();
      return;
    }

    const stock = nseEqUniverse[backgroundPreloadIndex];
    backgroundPreloadIndex++;

    try {
      if (!historicalDailyCandles[stock.symbol]) {
        const symbolKey = stock.symbol.endsWith("-EQ") ? stock.symbol : `${stock.symbol}-EQ`;
        const instrument = symbolToTokenMap[symbolKey];
        if (instrument) {
          await fetchHistoricalDailyCandles(stock.symbol, instrument.token, instrument.segment);
        }
      }
    } catch (err) {
      console.error(`[ScannerEngine] Failed background preload for ${stock.symbol}:`, err.message);
    }

    setTimeout(loadNext, 400);
  }

  loadNext();
}

/**
 * Preloads real historical daily candles for all target indices and STOCK_UNIVERSE.
 */
async function preloadAllHistoricalDailyCandles() {
  if (isOfflineMode) {
    console.log("[ScannerEngine] Offline mode: Seeding historical daily candles with mock series...");
    
    const targets = ["Nifty 50", "Nifty Bank", "SENSEX", ...STOCK_UNIVERSE.map(s => s.symbol)];
    targets.forEach(sym => {
      let basePrice = 1000;
      const stock = STOCK_UNIVERSE.find(s => s.symbol === sym);
      if (stock) basePrice = stock.price;
      else if (sym.includes("Nifty 50")) basePrice = 22000;
      else if (sym.includes("Nifty Bank")) basePrice = 47000;
      else if (sym === "SENSEX") basePrice = 72000;

      historicalDailyCandles[sym] = generateMockCandles(sym, basePrice, 150);
    });
    return;
  }

  console.log("[ScannerEngine] Preloading real historical daily candles from SmartAPI...");
  const targets = [
    { symbolKey: "Nifty 50", symbol: "Nifty 50" },
    { symbolKey: "Nifty Bank", symbol: "Nifty Bank" },
    { symbolKey: "SENSEX", symbol: "SENSEX" },
    ...STOCK_UNIVERSE.map(s => ({ symbolKey: s.symbol, symbol: s.isFO ? `${s.symbol}-EQ` : s.symbol }))
  ];

  for (const item of targets) {
    let instrument = symbolToTokenMap[item.symbol];
    if (!instrument && item.symbolKey === "INFOSYS") instrument = symbolToTokenMap["INFY-EQ"];
    if (!instrument && item.symbolKey === "BHARTIRTEL") instrument = symbolToTokenMap["BHARTIARTL-EQ"];
    if (!instrument && item.symbolKey === "TATAMOTORS") instrument = symbolToTokenMap["TMPV-EQ"];

    if (!instrument) {
      console.warn(`[ScannerEngine] Mapped instrument not found for ${item.symbolKey} (${item.symbol}) during preload`);
      continue;
    }

    const success = await fetchHistoricalDailyCandles(item.symbolKey, instrument.token, instrument.segment);
    if (!success) {
      let basePrice = 1000;
      const stock = STOCK_UNIVERSE.find(s => s.symbol === item.symbolKey);
      if (stock) basePrice = stock.price;
      historicalDailyCandles[item.symbolKey] = generateMockCandles(item.symbolKey, basePrice, 150);
    }
    
    // Sleep 400ms to respect API rate limits
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  console.log("[ScannerEngine] Historical daily candles preloading complete.");
  saveHistoricalDailyCandlesToCache();
}

async function fetchHistoricalIntradayCandles(symbolKey, token, segment, interval) {
  let attempts = 0;
  while (attempts < 2) {
    try {
      const api = getSmartApiInstance();
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - 15);

      const formatOffsetDate = (date) => {
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 09:15`;
      };

      const fromStr = formatOffsetDate(fromDate);
      const toStr = formatOffsetDate(toDate);

      console.log(`[ScannerEngine] Fetching historical ${interval} candles for ${symbolKey} (${token})...`);

      const response = await api.getCandleData({
        exchange: segment === "BSE" ? "BSE" : "NSE",
        symboltoken: token,
        interval: interval,
        fromdate: fromStr,
        todate: toStr
      });

      if (response && response.status === true && response.data && response.data.length > 0) {
        const candles = response.data.map(c => ({
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
        historicalIntradayCandles[symbolKey][interval] = candles;
        console.log(`[ScannerEngine] Cached ${candles.length} real ${interval} candles for ${symbolKey}.`);
        return true;
      }
    } catch (err) {
      if (err.message && err.message.includes('AG8001')) {
        console.warn(`[ScannerEngine] Token expired while fetching ${interval} candles for ${symbolKey}, reinitializing...`);
        try {
          await initializeSession();
        } catch (initErr) {
          return false;
        }
        attempts++;
        continue;
      }
      console.error(`[ScannerEngine] Failed to fetch ${interval} candles for ${symbolKey}:`, err.message);
    }
    break;
  }
  return false;
}

function generateMockIntradayCandles(symbol, basePrice, count = 250) {
  const candles = [];
  let price = basePrice;
  const now = new Date();
  for (let i = count; i > 0; i--) {
    const time = new Date(now.getTime() - i * 15 * 60 * 1000);
    const change = (Math.random() - 0.5) * (price * 0.002);
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * (price * 0.001);
    const low = Math.min(open, close) - Math.random() * (price * 0.001);
    price = close;
    candles.push({
      date: time.toISOString(),
      open,
      high,
      low,
      close,
      volume: Math.floor(Math.random() * 50000)
    });
  }
  return candles;
}

async function preloadAllHistoricalIntradayCandles() {
  if (isOfflineMode) {
    console.log("[ScannerEngine] Offline mode: Seeding historical intraday candles with mock series...");
    const targets = ["Nifty 50", "Nifty Bank", "SENSEX"];
    targets.forEach(sym => {
      let basePrice = 22000;
      if (sym.includes("Bank")) basePrice = 47000;
      else if (sym === "SENSEX") basePrice = 72000;
      if (!historicalIntradayCandles[sym]) {
        historicalIntradayCandles[sym] = {};
      }
      historicalIntradayCandles[sym]["ONE_MINUTE"] = generateMockIntradayCandles(sym, basePrice, 1000);
      historicalIntradayCandles[sym]["THREE_MINUTE"] = generateMockIntradayCandles(sym, basePrice, 500);
    });
    saveHistoricalIntradayCandlesToCache();
    return;
  }

  console.log("[ScannerEngine] Preloading real historical intraday index candles from SmartAPI...");
  const targets = [
    { symbolKey: "Nifty 50", symbol: "Nifty 50" },
    { symbolKey: "Nifty Bank", symbol: "Nifty Bank" },
    { symbolKey: "SENSEX", symbol: "SENSEX" }
  ];

  for (const item of targets) {
    const instrument = symbolToTokenMap[item.symbol];
    if (!instrument) {
      console.warn(`[ScannerEngine] Mapped instrument not found for ${item.symbolKey} (${item.symbol}) during intraday preload`);
      continue;
    }

    // Fetch ONE_MINUTE
    let ok1 = await fetchHistoricalIntradayCandles(item.symbolKey, instrument.token, instrument.segment, "ONE_MINUTE");
    await new Promise(resolve => setTimeout(resolve, 400));
    
    // Fetch THREE_MINUTE
    let ok3 = await fetchHistoricalIntradayCandles(item.symbolKey, instrument.token, instrument.segment, "THREE_MINUTE");
    await new Promise(resolve => setTimeout(resolve, 400));

    if (!ok1 || !ok3) {
      let basePrice = 22000;
      if (item.symbolKey.includes("Bank")) basePrice = 47000;
      else if (item.symbolKey === "SENSEX") basePrice = 72000;
      if (!historicalIntradayCandles[item.symbolKey]) {
        historicalIntradayCandles[item.symbolKey] = {};
      }
      historicalIntradayCandles[item.symbolKey]["ONE_MINUTE"] = generateMockIntradayCandles(item.symbolKey, basePrice, 1000);
      historicalIntradayCandles[item.symbolKey]["THREE_MINUTE"] = generateMockIntradayCandles(item.symbolKey, basePrice, 500);
    }
  }

  console.log("[ScannerEngine] Historical intraday candles preloading complete.");
  saveHistoricalIntradayCandlesToCache();
}

function buildUnifiedIndexCandles(oneMin, threeMin) {
  const unified = [];

  const getTimeString = (dateStr) => {
    const parts = dateStr.split("T");
    if (parts.length < 2) return "";
    return parts[1].substring(0, 5); // "HH:MM"
  };

  if (oneMin) {
    for (const c of oneMin) {
      const timeStr = getTimeString(c.date);
      if (timeStr >= "09:16" && timeStr <= "10:15") {
        unified.push({ ...c, timeframe: "1M" });
      }
    }
  }

  if (threeMin) {
    for (const c of threeMin) {
      const timeStr = getTimeString(c.date);
      if (timeStr >= "10:16" && timeStr <= "15:30") {
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
    "swing-tracker": 4 * 60 * 60 * 1000,            // 4 Hours
    "early-swing-reversal": 15 * 60 * 1000,         // 15 Minutes
    "swing-trades": 30 * 60 * 1000,                 // 30 Minutes
    "swing-momentum-breakout": 60 * 60 * 1000        // 1 Hour
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
 * Seeds mock candles for a stock in offline mode.
 */
function generateMockCandles(symbol, basePrice, count = 100) {
  const candles = [];
  let price = basePrice;
  const now = Date.now();
  for (let i = count; i > 0; i--) {
    const change = (Math.random() - 0.48) * (price * 0.015);
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * (price * 0.005);
    const low = Math.min(open, close) - Math.random() * (price * 0.005);
    price = close;

    candles.push({
      date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      open,
      high,
      low,
      close,
      volume: 10000 + Math.floor(Math.random() * 50000)
    });
  }
  return candles;
}

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

  // If we are in live mode but tickCache is empty, hold calculations
  if (!isOfflineMode && Object.keys(tickCache).length === 0) {
    return;
  }

  // If we are in offline mode, mock/tick indices and sector indices
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
  const niftyClose = niftyData ? (niftyData.close || niftyPrice) : 21958.25;
  const niftyChange = Number((niftyPrice - niftyClose).toFixed(2));

  const bankNiftyPrice = bankNiftyData ? bankNiftyData.ltp : 47420.95;
  const bankNiftyChangePercent = bankNiftyData ? bankNiftyData.changePercent : 1.11;
  const bankNiftyClose = bankNiftyData ? (bankNiftyData.close || bankNiftyPrice) : 46900.80;
  const bankNiftyChange = Number((bankNiftyPrice - bankNiftyClose).toFixed(2));

  const sensexPrice = sensexData ? sensexData.ltp : 72648.30;
  const sensexChangePercent = sensexData ? sensexData.changePercent : 0.85;
  const sensexClose = sensexData ? (sensexData.close || sensexPrice) : 72036.10;
  const sensexChange = Number((sensexPrice - sensexClose).toFixed(2));

  const giftNiftyPrice = Number((niftyPrice + 35.5).toFixed(2));
  const giftNiftyChangePercent = niftyChangePercent;
  const giftNiftyChange = niftyChange;

  // Pre-filter stocks using Global Pre-Filter
  const activeStocks = nseEqUniverse.filter(stock => {
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = isOfflineMode ? stock : (tickCache[symbolKey] || stock);
    const price = liveData.price || liveData.ltp || 0;

    // Filter out penny stocks (price > 80)
    return price > 80;
  });

  const updatedScanners = {};



  // Pre-calculate stock indicators mapping for this batch run
  const stockIndicatorsMap = {};
  activeStocks.forEach(stock => {
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = isOfflineMode ? stock : (tickCache[symbolKey] || stock);
    const ltp = liveData.price || liveData.ltp || 0;
    
    // Use real cached daily historical candles, appending current live tick
    let candles = historicalDailyCandles[stock.symbol];
    if (!candles || candles.length === 0) {
      candles = generateMockCandles(stock.symbol, ltp, 100);
    } else {
      candles = JSON.parse(JSON.stringify(candles));
      const lastCandle = candles[candles.length - 1];
      const nowStr = new Date().toISOString().split("T")[0];
      if (lastCandle.date === nowStr) {
        lastCandle.close = ltp;
        lastCandle.high = Math.max(lastCandle.high, ltp);
        lastCandle.low = Math.min(lastCandle.low, ltp);
        if (liveData.volume) lastCandle.volume = liveData.volume;
      } else if (isMarketOpen() || isOfflineMode) {
        candles.push({
          date: nowStr,
          open: liveData.open || ltp,
          high: Math.max(liveData.open || ltp, ltp),
          low: Math.min(liveData.open || ltp, ltp),
          close: ltp,
          volume: liveData.volume || 100000
        });
        if (candles.length > 150) candles.shift();
      }
    }

    stockIndicatorsMap[stock.symbol] = getStockIndicators(candles);
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

    // Clear sticky cache for swing scanners to only show today's triggers
    const isSwingScanner = ["swing-tracker", "early-swing-reversal", "swing-trades", "swing-momentum-breakout"].includes(scannerId);
    if (isSwingScanner) {
      activeSignalsMemory[scannerId] = {};
    }

    const currentSignals = [];
    const targetStocks = (scannerId === "swing-tracker") ? nseEqUniverse : activeStocks;

    for (const stock of targetStocks) {
      if (isEtf(stock.symbol)) continue; // skip ETF globally
      if (scannerId === "swing-tracker" && !isOfflineMode && !historicalDailyCandles[stock.symbol]) {
        continue;
      }
      const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
      const liveData = isOfflineMode ? stock : (tickCache[symbolKey] || stock);
      const ltp = liveData.price || liveData.ltp || 0;
      const change = liveData.changePercent || liveData.change || 0;

      const ind = stockIndicatorsMap[stock.symbol] || {
        currentRsi: 50, avgVol10: 100000, avgVol20: 100000, maxHigh: ltp, minLow: ltp, pdh: ltp, prevClose: ltp
      };
      const rsiVal = ind.currentRsi;
      const volumeRatio = (liveData.volume || 100000) / ind.avgVol10;

      // Check technical trigger conditions (Simplified rules for demo/calculation)
      let triggered = false;
      let strengthScore = 50;
      let direction = "BULLISH";

      switch (scannerId) {
        case "bullish-intraday":
          triggered = change > 1.2 && rsiVal > 55;
          strengthScore = Math.round(0.4 * rsiVal + 30);
          break;
        case "bearish-intraday":
          triggered = change < -1.2 && rsiVal < 45;
          strengthScore = Math.round(0.4 * (100 - rsiVal) + 30);
          direction = "BEARISH";
          break;
        case "options-opportunities":
          triggered = (change > 1.5 && rsiVal > 58) || (change < -1.5 && rsiVal < 42);
          direction = change > 0 ? "CALL" : "PUT";
          strengthScore = Math.round(0.3 * (change > 0 ? rsiVal : 100 - rsiVal) + 50);
          break;
        case "swing-trades":
        case "swing-momentum-breakout":
          triggered = rsiVal > 60 && volumeRatio > 1.2;
          strengthScore = Math.min(100, Math.round(rsiVal + 20));
          break;
        case "soon-breakouts":
          triggered = change > 0.5 && rsiVal > 52 && volumeRatio > 1.1;
          strengthScore = Math.round(rsiVal + 15);
          break;
        case "52week-high":
          triggered = ltp >= ind.maxHigh * 0.995 || ltp > ind.maxHigh;
          strengthScore = ltp > ind.maxHigh ? 90 : 70;
          break;
        case "52week-low":
          triggered = ltp <= ind.minLow * 1.005;
          strengthScore = ltp < ind.minLow ? 90 : 70;
          direction = "BEARISH";
          break;
        case "range-breakouts":
          const rangePct = (ind.maxHigh - ind.minLow) / ind.minLow * 100;
          triggered = rangePct < 5 && volumeRatio > 2;
          strengthScore = Math.min(100, Math.round(volumeRatio * 30));
          break;
        case "volume-explosions":
          triggered = volumeRatio >= 2.5 && (change > 1 || change < -1);
          strengthScore = Math.min(100, Math.round(volumeRatio * 25));
          break;
        case "rs-leaders": {
          const stockReturn = change;
          const niftyReturn = (tickCache["Nifty 50"] ? tickCache["Nifty 50"].changePercent : 0.83) || 0.83;
          const rsRatio = niftyReturn === 0 ? 1 : stockReturn / niftyReturn;
          triggered = rsRatio > 1.2;
          strengthScore = Math.min(100, Math.round(rsRatio * 50));
          break;
        }
        case "rs-weakness": {
          const stockReturnW = change;
          const niftyReturnW = (tickCache["Nifty 50"] ? tickCache["Nifty 50"].changePercent : 0.83) || 0.83;
          const rsRatioW = niftyReturnW === 0 ? 1 : stockReturnW / niftyReturnW;
          triggered = rsRatioW < 0.8;
          strengthScore = Math.min(100, Math.round((1.5 - rsRatioW) * 50));
          direction = "BEARISH";
          break;
        }
        case "ema-scans":
          triggered = ind.currentEma20 > ind.currentEma50 && ind.currentEma50 > ind.currentEma200 && ind.ema20Rising && ind.ema50Rising;
          strengthScore = Math.round(rsiVal + 12);
          break;
        case "momentum-leaders": {
          const emaDist = ind.currentEma20 > 0 ? (ltp - ind.currentEma20) / ind.currentEma20 * 100 : 0;
          triggered = rsiVal > 55 && change > 1.0;
          strengthScore = Math.min(100, Math.round(0.5 * rsiVal + 0.3 * emaDist + 0.2 * volumeRatio * 10));
          break;
        }
        case "high-delivery": {
          const deliveryPct = 50 + (stock.symbol.charCodeAt(0) % 25);
          triggered = deliveryPct >= 50 && (liveData.volume || 100000) > ind.avgVol10;
          strengthScore = Math.round(deliveryPct);
          break;
        }
        case "fo-active": {
          triggered = stock.isFO === true;
          const tradedValueVal = ltp * (liveData.volume || 100000);
          strengthScore = Math.min(100, Math.round(tradedValueVal / 10000000));
          break;
        }
        case "daily-breakouts":
          triggered = ltp > ind.pdh && change > 1.5 && (liveData.volume || 100000) > ind.avgVol10;
          strengthScore = Math.min(100, Math.round(change * 15 + 40));
          break;
        case "gap-up":
          triggered = liveData.open >= ind.prevClose * 1.01 && ltp > liveData.open;
          strengthScore = Math.min(100, Math.round(change * 15 + 40));
          break;
        case "gap-down":
          triggered = liveData.open <= ind.prevClose * 0.99 && ltp < liveData.open;
          strengthScore = Math.min(100, Math.round(Math.abs(change) * 15 + 40));
          direction = "BEARISH";
          break;
        case "swing-tracker": {
          let trackerCandles = historicalDailyCandles[stock.symbol];
          if (!trackerCandles || trackerCandles.length === 0) {
            trackerCandles = generateMockCandles(stock.symbol, ltp, 50);
          } else {
            trackerCandles = JSON.parse(JSON.stringify(trackerCandles));
            const lastCandle = trackerCandles[trackerCandles.length - 1];
            const nowStr = new Date().toISOString().split("T")[0];
            if (lastCandle.date === nowStr) {
              lastCandle.close = ltp;
              lastCandle.high = Math.max(lastCandle.high, ltp);
              lastCandle.low = Math.min(lastCandle.low, ltp);
            } else if (isMarketOpen() || isOfflineMode) {
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
          }
          const trackerRes = calculateSwingTracker(trackerCandles);
          const lastSignal = trackerRes.signals[trackerRes.signals.length - 1];
          const lastCandle = trackerCandles[trackerCandles.length - 1];
          triggered = lastSignal && lastSignal.date === lastCandle.date;
          direction = lastSignal && lastSignal.action === "BUY" ? "BULLISH" : "BEARISH";
          strengthScore = trackerRes.summary.winRate || 50;
          break;
        }
        case "early-swing-reversal": {
          const ema9_5days = ind.ema9[ind.ema9.length - 6] || ind.ema9[0];
          const ema21_5days = ind.ema21[ind.ema21.length - 6] || ind.ema21[0];
          triggered = ind.currentEma9 > ind.currentEma21 && ema9_5days <= ema21_5days && rsiVal > 55 && ltp > ind.currentEma9 && (liveData.volume || 100000) > ind.avgVol10;
          strengthScore = Math.min(100, Math.round(rsiVal + 15));
          break;
        }
        case "institutional-accumulation": {
          const dayHigh = liveData.high || ltp;
          const dayLow = liveData.low || (ltp * 0.98);
          const rangeDay = Math.max(dayHigh - dayLow, 0.05);
          const closeNearHigh = ltp >= dayHigh - rangeDay * 0.15;
          const deliveryPctAcc = 50 + (stock.symbol.charCodeAt(0) % 25);
          triggered = closeNearHigh && (liveData.volume || 100000) > 2 * ind.avgVol20 && deliveryPctAcc > 60;
          strengthScore = Math.min(100, Math.round(deliveryPctAcc + 10));
          break;
        }
        case "top-gainers":
          triggered = change > 0;
          strengthScore = Math.min(100, Math.round(change * 10 + 50));
          direction = "BULLISH";
          break;
        case "top-losers":
          triggered = change < 0;
          strengthScore = Math.min(100, Math.round(Math.abs(change) * 10 + 50));
          direction = "BEARISH";
          break;
        default:
          triggered = change > 1.0;
          strengthScore = 60;
          break;
      }

      // Check Signal Memory (Sticky signals)
      const existingSignal = activeSignalsMemory[scannerId][stock.symbol];

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
            timestamp: new Date().toLocaleTimeString(),
            triggerTime: new Date().toLocaleTimeString(),
            triggerPrice: ltp,
            postTriggerChange: 0,
            strengthScore: strengthScore,
            sector: stock.sector,
            isFO: stock.isFO
          };

          activeSignalsMemory[scannerId][stock.symbol] = signalInfo;

          // Dispatch real-time signal alert to frontend
          broadcastNewSignal({
            scannerId,
            ...signalInfo
          });

          // Dispatch push notifications asynchronously
          handleNewSignalPush(scannerId, signalInfo);
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

    // Sort signals by strengthScore descending
    currentSignals.sort((a, b) => b.strengthScore - a.strengthScore);

    // Broadcast scanner update via Socket.IO
    broadcastScannerUpdate(scannerId, currentSignals);
    updatedScanners[scannerId] = currentSignals;
  }



  // (Offline mock index block moved to top)

  // Calculate Nifty 50 signals
  let niftyOne = historicalIntradayCandles["Nifty 50"]?.["ONE_MINUTE"] || [];
  let niftyThree = historicalIntradayCandles["Nifty 50"]?.["THREE_MINUTE"] || [];
  if (niftyOne.length === 0 || niftyThree.length === 0) {
    niftyOne = generateMockIntradayCandles("Nifty 50", niftyPrice, 500);
    niftyThree = generateMockIntradayCandles("Nifty 50", niftyPrice, 300);
  }
  let niftyUnified = buildUnifiedIndexCandles(niftyOne, niftyThree);
  if (niftyUnified.length > 0) {
    niftyUnified = JSON.parse(JSON.stringify(niftyUnified));
    const lastBar = niftyUnified[niftyUnified.length - 1];
    lastBar.close = niftyPrice;
    lastBar.high = Math.max(lastBar.high, niftyPrice);
    lastBar.low = Math.min(lastBar.low, niftyPrice);
  }
  const niftyTrades = generateIndexTrades(niftyUnified, 30, 30, "NIFTY");
  const niftyActiveTrade = niftyTrades[niftyTrades.length - 1] || {
    type: "NEUTRAL",
    entryPrice: 0,
    stopLossPrice: 0,
    pnlAmount: 0,
    signalStrength: "STRONG",
    entryDate: "—"
  };

  // Calculate Nifty Bank signals
  let bankNiftyOne = historicalIntradayCandles["Nifty Bank"]?.["ONE_MINUTE"] || [];
  let bankNiftyThree = historicalIntradayCandles["Nifty Bank"]?.["THREE_MINUTE"] || [];
  if (bankNiftyOne.length === 0 || bankNiftyThree.length === 0) {
    bankNiftyOne = generateMockIntradayCandles("Nifty Bank", bankNiftyPrice, 500);
    bankNiftyThree = generateMockIntradayCandles("Nifty Bank", bankNiftyPrice, 300);
  }
  let bankNiftyUnified = buildUnifiedIndexCandles(bankNiftyOne, bankNiftyThree);
  if (bankNiftyUnified.length > 0) {
    bankNiftyUnified = JSON.parse(JSON.stringify(bankNiftyUnified));
    const lastBar = bankNiftyUnified[bankNiftyUnified.length - 1];
    lastBar.close = bankNiftyPrice;
    lastBar.high = Math.max(lastBar.high, bankNiftyPrice);
    lastBar.low = Math.min(lastBar.low, bankNiftyPrice);
  }
  const bankNiftyTrades = generateIndexTrades(bankNiftyUnified, 50, 50, "BANKNIFTY");
  const bankNiftyActiveTrade = bankNiftyTrades[bankNiftyTrades.length - 1] || {
    type: "NEUTRAL",
    entryPrice: 0,
    stopLossPrice: 0,
    pnlAmount: 0,
    signalStrength: "STRONG",
    entryDate: "—"
  };

  // Calculate SENSEX signals
  let sensexOne = historicalIntradayCandles["SENSEX"]?.["ONE_MINUTE"] || [];
  let sensexThree = historicalIntradayCandles["SENSEX"]?.["THREE_MINUTE"] || [];
  if (sensexOne.length === 0 || sensexThree.length === 0) {
    sensexOne = generateMockIntradayCandles("SENSEX", sensexPrice, 500);
    sensexThree = generateMockIntradayCandles("SENSEX", sensexPrice, 300);
  }
  let sensexUnified = buildUnifiedIndexCandles(sensexOne, sensexThree);
  if (sensexUnified.length > 0) {
    sensexUnified = JSON.parse(JSON.stringify(sensexUnified));
    const lastBar = sensexUnified[sensexUnified.length - 1];
    lastBar.close = sensexPrice;
    lastBar.high = Math.max(lastBar.high, sensexPrice);
    lastBar.low = Math.min(lastBar.low, sensexPrice);
  }
  const sensexTrades = generateIndexTrades(sensexUnified, 60, 50, "SENSEX");
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

  const getTopStocksForSector = (sectorName) => {
    let targetSector = "";
    const name = sectorName.toUpperCase();
    if (name.includes("BANK")) targetSector = "Banking";
    else if (name.includes("IT")) targetSector = "IT";
    else if (name.includes("PHARMA") || name.includes("HEALTHCARE") || name.includes("HLTH")) targetSector = "Pharma";
    else if (name.includes("AUTO")) targetSector = "Auto";
    else if (name.includes("FMCG") || name.includes("DURABLES")) targetSector = "FMCG";
    else if (name.includes("METAL") || name.includes("CEMENT") || name.includes("CHEMICAL")) targetSector = "Metals";
    else if (name.includes("ENERGY") || name.includes("OIL") || name.includes("GAS")) targetSector = "Energy";
    else targetSector = "Metals"; // default fallback

    const sectorStocks = STOCK_UNIVERSE.filter(s => s.sector === targetSector);
    
    return sectorStocks
      .map(s => {
        const symbolKey = s.isFO ? `${s.symbol}-EQ` : s.symbol;
        const live = tickCache[symbolKey] || s;
        return { symbol: s.symbol, change: live.changePercent || live.change || 0 };
      })
      .sort((a, b) => b.change - a.change)
      .map(s => s.symbol)
      .slice(0, 3);
  };

  const sectorsData = sectorsConfig.map(cfg => {
    const idxData = tickCache[cfg.indexSymbol];
    let changePercent = idxData ? idxData.changePercent : 0;
    if (cfg.offset) {
      changePercent = Number((changePercent + cfg.offset).toFixed(2));
    }
    
    const score = Math.min(100, Math.max(0, Math.round(50 + changePercent * 15)));
    const weeklyChange = Number((changePercent * 3).toFixed(2));
    const topStocks = getTopStocksForSector(cfg.name);

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
 * Runs an offline mock pricing feeder to simulate price updates when API credentials aren't set.
 */
function startOfflineMockFeeder() {
  console.log("[ScannerEngine] Booting offline mock data feeder...");
  
  offlineMockInterval = setInterval(() => {
    // 1. Pick a random stock to update its price
    const stock = STOCK_UNIVERSE[Math.floor(Math.random() * STOCK_UNIVERSE.length)];
    if (stock) {
      const change = (Math.random() - 0.49) * 0.8; // Minor tick
      stock.price = Number((stock.price + change).toFixed(2));
      stock.changePercent = Number(((stock.price - (stock.price - change * 3)) / stock.price * 100).toFixed(2));

      // Broadcast price update to room subscribers
      broadcastPriceUpdate(stock.symbol, stock.price, stock.changePercent);
    }

    // 2. Also generate ticks for any active symbol subscriptions (like details views or closed tracker tables)
    try {
      const { getSubscribedSymbols } = require("./socketServer");
      const activeSubSymbols = getSubscribedSymbols();
      
      activeSubSymbols.forEach(symbol => {
        let uStock = STOCK_UNIVERSE.find(s => s.symbol === symbol);
        if (!uStock && typeof nseEqUniverse !== "undefined") {
          uStock = nseEqUniverse.find(s => s.symbol === symbol);
        }
        
        if (uStock) {
          const tickChange = (Math.random() - 0.49) * 1.2;
          uStock.price = Number(((uStock.price || 250) + tickChange).toFixed(2));
          const currentChange = uStock.changePercent || 0;
          uStock.changePercent = Number((currentChange + (Math.random() - 0.5) * 0.2).toFixed(2));
          broadcastPriceUpdate(symbol, uStock.price, uStock.changePercent);
        } else {
          // Fallback if not found in universe
          const tickChange = (Math.random() - 0.49) * 1.2;
          const mockPrice = Number((250 + tickChange).toFixed(2));
          broadcastPriceUpdate(symbol, mockPrice, 0.5);
        }
      });
    } catch (err) {
      console.error("[ScannerEngine] Mock subscription tick failed:", err.message);
    }
  }, 1000);
}

/**
 * Helper to check if Indian Stock Market (NSE/BSE) is open.
 * Market Hours: Monday - Friday, 9:15 AM to 3:30 PM IST (UTC+5:30)
 */
function isMarketOpen() {
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDate = now.getUTCDate();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const utcSeconds = now.getUTCSeconds();
  
  // Create Date object representing IST (UTC + 5.5 hours)
  const istDate = new Date(Date.UTC(utcYear, utcMonth, utcDate, utcHours, utcMinutes, utcSeconds) + (5.5 * 60 * 60 * 1000));
  
  const day = istDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  
  const hours = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  const timeInMinutes = hours * 60 + minutes;
  
  // 9:15 AM is 555 minutes. 3:30 PM is 930 minutes.
  return timeInMinutes >= 555 && timeInMinutes <= 930;
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
      ...STOCK_UNIVERSE
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
          const ltp = parseFloat(item.ltp);
          const close = parseFloat(item.close || ltp);
          const changePercent = close > 0 ? ((ltp - close) / close) * 100 : 0;
          const volume = parseInt(item.tradeVolume) || 0;

          // Update tickCache
          tickCache[symbolKey] = {
            ltp: ltp,
            volume: volume,
            changePercent: Number(changePercent.toFixed(2)),
            timestamp: new Date().toLocaleTimeString(),
            token: instrument.token,
            segment: instrument.segment,
            price: ltp,
            close: close
          };

          // Update in STOCK_UNIVERSE so global filters and initial values match
          const baseSymbol = symbolKey.split("-")[0];
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

      // Rest limit sleep (100ms)
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (err) {
    console.error("[ScannerEngine] fetchRealClosingPrices bulk retrieval failed:", err.message);
  }
}

/**
 * Starts the 2-second calculation loop if not already running.
 */
function startCalculationLoop() {
  if (calculationInterval) return;
  console.log(`[ScannerEngine] Starting 2-second calculation loop (Mode: ${isOfflineMode ? "Offline/Mock" : "Live API"})...`);
  calculationInterval = setInterval(() => {
    evaluateAllScanners().catch(err => {
      console.error("[ScannerEngine] Loop calculation error:", err.message);
    });
  }, 2000);
}

/**
 * Stops the 2-second calculation loop.
 */
function stopCalculationLoop() {
  if (calculationInterval) {
    console.log("[ScannerEngine] Stopping 2-second calculation loop.");
    clearInterval(calculationInterval);
    calculationInterval = null;
  }
}

/**
 * Initializes and starts the background calculation engine.
 */
function startScannerEngine() {
  const apiKey = process.env.SMARTAPI_API_KEY;
  const credentialsMissing = !apiKey || apiKey === "YOUR_API_KEY";
  const forceMock = process.env.USE_MOCK_FEED === "true";

  isOfflineMode = credentialsMissing || forceMock;
  lastKnownMarketOpenState = isMarketOpen();

  // Load historical daily candles from cache at startup
  loadHistoricalDailyCandlesFromCache();
  loadHistoricalIntradayCandlesFromCache();

  if (isOfflineMode) {
    console.log("[ScannerEngine] Running in offline/mock data mode.");
    startOfflineMockFeeder();
    initializeNseEqUniverse()
      .then(() => preloadAllHistoricalDailyCandles())
      .then(() => preloadAllHistoricalIntradayCandles())
      .then(() => startCalculationLoop())
      .then(() => startBackgroundCandlePreload());
  } else {
    console.log("[ScannerEngine] Running in Live API mode.");
    if (!lastKnownMarketOpenState) {
      console.log("[ScannerEngine] Market is currently closed. Fetching real closing prices once...");
      fetchRealClosingPrices()
        .then(() => initializeNseEqUniverse())
        .then(() => preloadAllHistoricalDailyCandles())
        .then(() => preloadAllHistoricalIntradayCandles())
        .then(() => {
          console.log("[ScannerEngine] All real closing prices & history loaded! Performing single evaluation...");
          return evaluateAllScanners();
        })
        .then(() => {
          console.log("[ScannerEngine] Initial closing evaluation completed. Engine idling until market hours.");
          startBackgroundCandlePreload();
        })
        .catch(err => console.error("[ScannerEngine] Failed to initialize closed market data:", err.message));
    } else {
      console.log("[ScannerEngine] Market is open. Initiating live feeds...");
      initializeNseEqUniverse()
        .then(() => preloadAllHistoricalDailyCandles())
        .then(() => preloadAllHistoricalIntradayCandles())
        .then(() => startCalculationLoop())
        .then(() => startBackgroundCandlePreload())
        .catch(err => console.error("[ScannerEngine] Failed to preload daily candles at startup:", err.message));
    }

    // Monitor market state changes every 15 seconds
    console.log("[ScannerEngine] Starting market hours monitor (15s interval)...");
    marketMonitorInterval = setInterval(() => {
      const currentlyOpen = isMarketOpen();
      if (currentlyOpen !== lastKnownMarketOpenState) {
        console.log(`[ScannerEngine] Market state changed! Open: ${currentlyOpen}`);
        lastKnownMarketOpenState = currentlyOpen;

        if (currentlyOpen) {
          console.log("[ScannerEngine] Market has opened. Activating live calculation loop.");
          startCalculationLoop();
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
  const targetStocks = (scannerId === "swing-tracker") ? nseEqUniverse : nseEqUniverse.filter(stock => {
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = isOfflineMode ? stock : (tickCache[symbolKey] || stock);
    const price = liveData.price || liveData.ltp || 0;
    return price > 80;
  });

  // Pre-calculate stock indicators mapping
  const stockIndicatorsMap = {};
  targetStocks.forEach(stock => {
    if (isEtf(stock.symbol)) return; // Skip ETF globally
    if (scannerId === "swing-tracker" && !isOfflineMode && !historicalDailyCandles[stock.symbol]) {
      return; // Skip if daily candles not preloaded yet
    }
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = isOfflineMode ? stock : (tickCache[symbolKey] || stock);
    const ltp = liveData.price || liveData.ltp || 0;
    
    let candles = historicalDailyCandles[stock.symbol];
    if (!candles || candles.length === 0) {
      candles = generateMockCandles(stock.symbol, ltp, 100);
    } else {
      candles = JSON.parse(JSON.stringify(candles));
      const lastCandle = candles[candles.length - 1];
      const nowStr = new Date().toISOString().split("T")[0];
      if (lastCandle.date === nowStr) {
        lastCandle.close = ltp;
        lastCandle.high = Math.max(lastCandle.high, ltp);
        lastCandle.low = Math.min(lastCandle.low, ltp);
        if (liveData.volume) lastCandle.volume = liveData.volume;
      } else if (isMarketOpen() || isOfflineMode) {
        candles.push({
          date: nowStr,
          open: liveData.open || ltp,
          high: Math.max(liveData.open || ltp, ltp),
          low: Math.min(liveData.open || ltp, ltp),
          close: ltp,
          volume: liveData.volume || 100000
        });
        if (candles.length > 150) candles.shift();
      }
    }

    stockIndicatorsMap[stock.symbol] = getStockIndicators(candles);
  });

  if (!activeSignalsMemory[scannerId]) {
    activeSignalsMemory[scannerId] = {};
  }

  // Clear sticky cache for swing scanners to only show today's triggers
  const isSwingScanner = ["swing-tracker", "early-swing-reversal", "swing-trades", "swing-momentum-breakout"].includes(scannerId);
  if (isSwingScanner) {
    activeSignalsMemory[scannerId] = {};
  }

  const currentSignals = [];

  for (const stock of targetStocks) {
    if (scannerId === "swing-tracker" && !isOfflineMode && !historicalDailyCandles[stock.symbol]) {
      continue;
    }
    const symbolKey = stock.isFO ? `${stock.symbol}-EQ` : stock.symbol;
    const liveData = isOfflineMode ? stock : (tickCache[symbolKey] || stock);
    const ltp = liveData.price || liveData.ltp || 0;
    const change = liveData.changePercent || liveData.change || 0;

    const ind = stockIndicatorsMap[stock.symbol] || {
      currentRsi: 50, avgVol10: 100000, avgVol20: 100000, maxHigh: ltp, minLow: ltp, pdh: ltp, prevClose: ltp
    };
    const rsiVal = ind.currentRsi;
    const volumeRatio = (liveData.volume || 100000) / ind.avgVol10;

    let triggered = false;
    let strengthScore = 50;
    let direction = "BULLISH";

    switch (scannerId) {
      case "swing-trades":
        triggered = rsiVal > 60 && volumeRatio > 1.2;
        strengthScore = Math.min(100, Math.round(rsiVal + 20));
        break;
      case "swing-momentum-breakout":
        triggered = rsiVal > 60 && volumeRatio > 1.2;
        strengthScore = Math.min(100, Math.round(rsiVal + 20));
        break;
      case "swing-tracker": {
        let trackerCandles = historicalDailyCandles[stock.symbol];
        if (!trackerCandles || trackerCandles.length === 0) {
          trackerCandles = generateMockCandles(stock.symbol, ltp, 50);
        } else {
          trackerCandles = JSON.parse(JSON.stringify(trackerCandles));
          const lastCandle = trackerCandles[trackerCandles.length - 1];
          const nowStr = new Date().toISOString().split("T")[0];
          if (lastCandle.date === nowStr) {
            lastCandle.close = ltp;
            lastCandle.high = Math.max(lastCandle.high, ltp);
            lastCandle.low = Math.min(lastCandle.low, ltp);
          } else if (isMarketOpen() || isOfflineMode) {
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
        }
        const trackerRes = calculateSwingTracker(trackerCandles);
        const lastSignal = trackerRes.signals[trackerRes.signals.length - 1];
        const lastCandle = trackerCandles[trackerCandles.length - 1];
        triggered = lastSignal && lastSignal.date === lastCandle.date;
        direction = lastSignal && lastSignal.action === "BUY" ? "BULLISH" : "BEARISH";
        strengthScore = trackerRes.summary.winRate || 50;
        break;
      }
      case "early-swing-reversal": {
        const ema9_5days = ind.ema9[ind.ema9.length - 6] || ind.ema9[0];
        const ema21_5days = ind.ema21[ind.ema21.length - 6] || ind.ema21[0];
        triggered = ind.currentEma9 > ind.currentEma21 && ema9_5days <= ema21_5days && rsiVal > 55 && ltp > ind.currentEma9 && (liveData.volume || 100000) > ind.avgVol10;
        strengthScore = Math.min(100, Math.round(rsiVal + 15));
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
        broadcastNewSignal({ scannerId, ...signalInfo });
        handleNewSignalPush(scannerId, signalInfo);
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
  if (offlineMockInterval) {
    clearInterval(offlineMockInterval);
    offlineMockInterval = null;
  }
  if (marketMonitorInterval) {
    clearInterval(marketMonitorInterval);
    marketMonitorInterval = null;
  }
}

function getHistoricalDailyCandles() {
  return historicalDailyCandles;
}

function getNseEqUniverse() {
  return nseEqUniverse;
}

module.exports = {
  startScannerEngine,
  stopScannerEngine,
  forceRecalculateScanner,
  getHistoricalDailyCandles,
  getHistoricalIntradayCandles,
  buildUnifiedIndexCandles,
  getStockIndicators,
  getNseEqUniverse
};
