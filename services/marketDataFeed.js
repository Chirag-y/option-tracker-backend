const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { WebSocketV2 } = require("smartapi-javascript");
const { getSession } = require("./smartApiSession");

// Local cache for scrip master to speed up server restarts
const SCRIP_MASTER_LOCAL_PATH = path.join(__dirname, "../config/scripMaster.json");
const SCRIP_MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

// In-memory mappings
const tokenToSymbolMap = {}; // token -> { symbol, name, segment }
const symbolToTokenMap = {}; // symbol -> { token, name, segment }
let tickCache = {};        // symbol -> { ltp, volume, changePercent, timestamp }

/**
 * Returns the latest live index price for the given symbol (e.g., NIFTY, BANKNIFTY, SENSEX).
 * It pulls the value from the in‑memory tickCache populated by the WebSocket.
 * If the symbol is not currently cached, null is returned.
 */
function getLiveIndexPrice(symbol) {
  if (!symbol) return null;
  const data = tickCache[symbol];
  return data ? data.ltp : null;
}

module.exports = {
  // existing exports (if any) will be merged below
  getLiveIndexPrice,
  // NOTE: other functions are exported later in this file as needed
};
let webSocketClient = null;
let subscribedTokens = new Set();

/**
 * Downloads the Scrip Master from Angel One and saves it locally.
 * If a valid cache exists, loads it from disk.
 */
async function loadScripMaster() {
  try {
    // Ensure config directory exists
    const dir = path.dirname(SCRIP_MASTER_LOCAL_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let downloadNeeded = true;

    if (fs.existsSync(SCRIP_MASTER_LOCAL_PATH)) {
      const stats = fs.statSync(SCRIP_MASTER_LOCAL_PATH);
      const now = new Date();
      // If file was modified today, use it
      if (stats.mtime.toDateString() === now.toDateString() && stats.size > 1000000) {
        downloadNeeded = false;
      }
    }

    let data;
    if (downloadNeeded) {
      console.log(`[MarketData] Downloading Scrip Master from Angel One...`);
      const response = await axios.get(SCRIP_MASTER_URL);
      data = response.data;
      fs.writeFileSync(SCRIP_MASTER_LOCAL_PATH, JSON.stringify(data));
      console.log(`[MarketData] Scrip Master saved locally.`);
    } else {
      console.log(`[MarketData] Loading Scrip Master from local cache...`);
      const fileContent = fs.readFileSync(SCRIP_MASTER_LOCAL_PATH, "utf-8");
      data = JSON.parse(fileContent);
    }

    console.log(`[MarketData] Parsing ${data.length} instruments...`);
    
    // Reset mappings without breaking external module references
    for (const key in tokenToSymbolMap) delete tokenToSymbolMap[key];
    for (const key in symbolToTokenMap) delete symbolToTokenMap[key];

    for (const item of data) {
      // We only care about NSE equity, NFO (futures/options), and Index segments
      const segment = item.exch_seg;
      if (segment === "NSE" || segment === "NFO" || segment === "BSE" || segment === "BFO") {
        const token = item.token;
        const symbol = item.symbol;
        const name = item.name;

        const instrumentInfo = {
          token,
          symbol,
          name,
          segment,
          lotsize: parseInt(item.lotsize) || 1,
          expiry: item.expiry,
          strike: parseFloat(item.strike) || 0,
          instrumenttype: item.instrumenttype
        };

        tokenToSymbolMap[token] = instrumentInfo;
        symbolToTokenMap[symbol] = instrumentInfo;
      }
    }

    console.log(`[MarketData] Mapped ${Object.keys(symbolToTokenMap).length} active instruments.`);
  } catch (error) {
    console.error("[MarketData] Error loading scrip master:", error.message);
    throw error;
  }
}

/**
 * Maps standard exchange segment strings to Angel One segment integers.
 */
function getExchangeType(segment) {
  switch (segment) {
    case "NSE":
      return 1;
    case "NFO":
      return 5;
    case "BSE":
      return 3;
    case "BFO":
      return 7;
    default:
      return 1;
  }
}

/**
 * Initializes and connects the WebSocket client using session details.
 */
async function connectWebSocket(symbolsToSubscribe = []) {
  try {
    const session = getSession();
    if (!session) {
      throw new Error("No active SmartAPI session. Login first.");
    }

    console.log("[MarketData] Connecting to SmartStream WebSocket V2...");
    
    webSocketClient = new WebSocketV2({
      jwttoken: session.jwtToken,
      apikey: process.env.SMARTAPI_API_KEY,
      clientcode: session.clientCode,
      feedtype: session.feedToken
    });

    webSocketClient.connect().then(() => {
      console.log("[MarketData] WebSocket connected successfully!");

      // If we have default symbols, subscribe to them
      if (symbolsToSubscribe.length > 0) {
        subscribeToSymbols(symbolsToSubscribe);
      }

      // Handle ticks
      webSocketClient.on("tick", (tick) => {
        handleIncomingTick(tick);
      });

      // Handle errors
      webSocketClient.on("error", (err) => {
        console.error("[MarketData] WebSocket Client Error:", err);
      });
    }).catch((err) => {
      console.error("[MarketData] WebSocket connection failed:", err);
    });

  } catch (error) {
    console.error("[MarketData] WebSocket connection initialization failed:", error.message);
    throw error;
  }
}

/**
 * Parses and updates the incoming tick payload into the tickCache.
 */
function handleIncomingTick(tick) {
  // Angel One WebSocket V2 returns tick object
  if (!tick || !tick.token) return;

  const token = tick.token;
  const instrument = tokenToSymbolMap[token];
  if (!instrument) return;

  let symbol = instrument.symbol;
  if (symbol === "INFY-EQ") symbol = "INFOSYS-EQ";
  if (symbol === "BHARTIARTL-EQ") symbol = "BHARTIRTEL-EQ";
  if (symbol === "TMPV-EQ") symbol = "TATAMOTORS-EQ";
  const lastTradedPrice = tick.last_traded_price / 100; // API returns values multiplied by 100
  const openPrice = tick.open / 100;
  const volume = tick.volume || 0;

  // Calculate change %
  let changePercent = 0;
  if (openPrice > 0) {
    changePercent = ((lastTradedPrice - openPrice) / openPrice) * 100;
  }

  // Update in-memory tickCache
  tickCache[symbol] = {
    ltp: lastTradedPrice,
    volume: volume,
    changePercent: Number(changePercent.toFixed(2)),
    timestamp: new Date().toLocaleTimeString(),
    token: token,
    segment: instrument.segment
  };
}

/**
 * Subscribes to a list of stock symbols.
 */
function subscribeToSymbols(symbols) {
  if (!webSocketClient) {
    console.warn("[MarketData] WebSocket not connected. Queueing subscriptions.");
    return;
  }

  // Group tokens by exchangeType to match subscription payload format
  const groups = {};

  for (const symbol of symbols) {
    // If the symbol has no suffix, default to -EQ (e.g. SBIN -> SBIN-EQ)
    let searchSymbol = symbol;
    if (!symbol.includes("-") && !symbol.toUpperCase().includes("NIFTY") && !symbol.toUpperCase().includes("SENSEX")) {
      searchSymbol = `${symbol}-EQ`;
    }
    if (searchSymbol === "INFOSYS-EQ") searchSymbol = "INFY-EQ";
    if (searchSymbol === "BHARTIRTEL-EQ") searchSymbol = "BHARTIARTL-EQ";
    if (searchSymbol === "TATAMOTORS-EQ") searchSymbol = "TMPV-EQ";

    const instrument = symbolToTokenMap[searchSymbol];
    if (!instrument) {
      console.warn(`[MarketData] Instrument not found for symbol: ${symbol}`);
      continue;
    }

    const exchangeType = getExchangeType(instrument.segment);
    const token = instrument.token;

    if (!subscribedTokens.has(token)) {
      subscribedTokens.add(token);
      if (!groups[exchangeType]) {
        groups[exchangeType] = [];
      }
      groups[exchangeType].push(token);
    }
  }

  // Send subscription requests for each exchange type group
  for (const exchangeType in groups) {
    const tokens = groups[exchangeType];
    if (tokens.length === 0) continue;

    console.log(`[MarketData] Subscribing to ${tokens.length} tokens on Exchange segment ${exchangeType}...`);
    
    const request = {
      correlationID: `sub_${Date.now()}_${exchangeType}`,
      action: 1, // 1 for subscribe
      mode: 2,   // 2 for Quote (LTP + Volume)
      exchangeType: parseInt(exchangeType),
      tokens: tokens
    };

    webSocketClient.fetchData(request);
  }
}

/**
 * Unsubscribes from a list of stock symbols.
 */
function unsubscribeFromSymbols(symbols) {
  if (!webSocketClient) return;

  const groups = {};

  for (const symbol of symbols) {
    let searchSymbol = symbol;
    if (!symbol.includes("-") && !symbol.toUpperCase().includes("NIFTY") && !symbol.toUpperCase().includes("SENSEX")) {
      searchSymbol = `${symbol}-EQ`;
    }
    if (searchSymbol === "INFOSYS-EQ") searchSymbol = "INFY-EQ";
    if (searchSymbol === "BHARTIRTEL-EQ") searchSymbol = "BHARTIARTL-EQ";
    if (searchSymbol === "TATAMOTORS-EQ") searchSymbol = "TMPV-EQ";

    const instrument = symbolToTokenMap[searchSymbol];
    if (!instrument) continue;

    const exchangeType = getExchangeType(instrument.segment);
    const token = instrument.token;

    if (subscribedTokens.has(token)) {
      subscribedTokens.delete(token);
      if (!groups[exchangeType]) {
        groups[exchangeType] = [];
      }
      groups[exchangeType].push(token);
    }
  }

  for (const exchangeType in groups) {
    const tokens = groups[exchangeType];
    if (tokens.length === 0) continue;

    console.log(`[MarketData] Unsubscribing from ${tokens.length} tokens on Exchange ${exchangeType}...`);
    
    const request = {
      correlationID: `unsub_${Date.now()}_${exchangeType}`,
      action: 0, // 0 for unsubscribe
      mode: 2,
      exchangeType: parseInt(exchangeType),
      tokens: tokens
    };

    webSocketClient.fetchData(request);
  }
}

/**
 * Gets the current cache of stock prices and volume data.
 */
function getTickCache() {
  return tickCache;
}

module.exports = {
  getLiveIndexPrice,
  loadScripMaster,
  connectWebSocket,
  subscribeToSymbols,
  unsubscribeFromSymbols,
  getTickCache,
  symbolToTokenMap,
  tokenToSymbolMap
};


