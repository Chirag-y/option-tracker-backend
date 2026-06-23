const { getTickCache, symbolToTokenMap, loadScripMaster } = require("./marketDataFeed");
const { getSmartApiInstance } = require("./smartApiSession");

const INDEX_OPTION_CONFIG = {
  NIFTY: {
    instrumentName: "NIFTY",
    exchange: "NFO",
    segment: "NFO",
    strikeStep: 50
  },
  BANKNIFTY: {
    instrumentName: "BANKNIFTY",
    exchange: "NFO",
    segment: "NFO",
    strikeStep: 100
  },
  SENSEX: {
    instrumentName: "SENSEX",
    exchange: "BFO",
    segment: "BFO",
    strikeStep: 100
  }
};

const optionDayCandlesCache = new Map();
const optionQuoteCache = new Map();

function getIndexOptionConfig(symbol) {
  return INDEX_OPTION_CONFIG[symbol] || null;
}

function parseExpiryDate(expiry) {
  if (!expiry) return null;
  const trimmed = String(expiry).trim().toUpperCase();
  const match = trimmed.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return null;

  const [, dayStr, monthStr, yearStr] = match;
  const monthMap = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11
  };

  const month = monthMap[monthStr];
  if (month === undefined) return null;

  return new Date(Date.UTC(Number(yearStr), month, Number(dayStr), 0, 0, 0, 0));
}

function getDatePart(dateTime) {
  if (!dateTime) return "";
  return String(dateTime).split("T")[0];
}

function getTimePart(dateTime) {
  if (!dateTime) return "";
  const parts = String(dateTime).split("T");
  if (parts.length < 2) return "";
  return parts[1].substring(0, 5);
}

function extractCandleRows(response) {
  if (!response) return [];
  const body = Array.isArray(response) ? { data: response } : (response.data && (Array.isArray(response.data) || response.data.data || response.data.candles || response.data.result) ? response.data : response);

  const candidates = [
    body?.data,
    body?.candles,
    body?.result,
    body?.rows,
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

function parseStrikeValue(rawStrike) {
  const numeric = Number(rawStrike);
  if (!Number.isFinite(numeric)) return 0;
  return numeric / 100;
}

function getOngoingExpiry(instruments, referenceDate = new Date()) {
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  const targetDate = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 0, 0, 0));
  const expiryMap = new Map();

  for (const instrument of instruments) {
    const expiryDate = parseExpiryDate(instrument.expiry);
    if (!expiryDate) continue;
    const key = expiryDate.toISOString();
    if (!expiryMap.has(key)) {
      expiryMap.set(key, expiryDate);
    }
  }

  const expiries = Array.from(expiryMap.values()).sort((a, b) => a - b);
  if (expiries.length === 0) return null;

  const upcoming = expiries.find((expiry) => expiry >= targetDate);
  return upcoming || expiries[expiries.length - 1];
}

function pickAtmStrikeInstrument(instruments, spotPrice, strikeStep) {
  const roundedSpot = Math.round(spotPrice / strikeStep) * strikeStep;
  const ranked = instruments
    .map((instrument) => ({
      instrument,
      strike: parseStrikeValue(instrument.strike)
    }))
    .sort((a, b) => {
      const distA = Math.abs(a.strike - roundedSpot);
      const distB = Math.abs(b.strike - roundedSpot);
      if (distA !== distB) return distA - distB;
      return a.strike - b.strike;
    });

  return ranked[0] ? { ...ranked[0].instrument, strikePrice: ranked[0].strike } : null;
}

function getOptionTickSymbol(contract) {
  return contract.symbol;
}

async function fetchLatestOptionQuote(contract) {
  const cacheKey = `${contract.segment}:${contract.token}`;
  const cached = optionQuoteCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < 1500) {
    return cached.price;
  }

  const tickCache = getTickCache() || {};
  const tick = tickCache[getOptionTickSymbol(contract)];
  if (tick && Number.isFinite(Number(tick.ltp))) {
    const price = Number(tick.ltp);
    optionQuoteCache.set(cacheKey, { fetchedAt: now, price });
    return price;
  }

  try {
    const api = getSmartApiInstance();
    const response = await api.marketData({
      mode: "LTP",
      exchangeTokens: {
        [contract.segment]: [contract.token]
      }
    });

    const fetched = response?.data?.fetched?.[0];
    const price = fetched ? Number(fetched.ltp) : NaN;
    if (Number.isFinite(price) && price > 0) {
      optionQuoteCache.set(cacheKey, { fetchedAt: now, price });
      return price;
    }
  } catch (err) {
    return null;
  }

  return null;
}

async function fetchOptionDayCandles(contract, datePart) {
  const cacheKey = `${contract.segment}:${contract.token}:${datePart}`;
  if (optionDayCandlesCache.has(cacheKey)) {
    return optionDayCandlesCache.get(cacheKey);
  }

  try {
    const api = getSmartApiInstance();
    const response = await api.getCandleData({
      exchange: contract.exchange,
      symboltoken: contract.token,
      interval: "ONE_MINUTE",
      fromdate: `${datePart} 09:15`,
      todate: `${datePart} 15:30`
    });

    const candles = extractCandleRows(response).map((candle) => ({
      date: candle[0],
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5]) || 0
    }));

    optionDayCandlesCache.set(cacheKey, candles);
    return candles;
  } catch (err) {
    optionDayCandlesCache.set(cacheKey, []);
    return [];
  }
}

function pickPriceFromCandles(candles, dateTime) {
  const timePart = getTimePart(dateTime);
  if (!timePart || candles.length === 0) return null;

  let latestBefore = null;
  for (const candle of candles) {
    const candleTime = getTimePart(candle.date);
    if (!candleTime) continue;
    if (candleTime <= timePart) {
      latestBefore = candle;
      continue;
    }
    break;
  }

  if (latestBefore && Number.isFinite(latestBefore.close)) {
    return Number(latestBefore.close);
  }

  const firstAfter = candles.find((candle) => {
    const candleTime = getTimePart(candle.date);
    return candleTime && candleTime >= timePart;
  });

  return firstAfter && Number.isFinite(firstAfter.close) ? Number(firstAfter.close) : null;
}

async function getOptionPriceAt(contract, dateTime, options = {}) {
  const { preferLive = false } = options;

  if (preferLive) {
    const livePrice = await fetchLatestOptionQuote(contract);
    if (livePrice !== null) {
      return livePrice;
    }
  }

  const datePart = getDatePart(dateTime);
  if (!datePart) return null;

  const candles = await fetchOptionDayCandles(contract, datePart);
  const candlePrice = pickPriceFromCandles(candles, dateTime);
  if (candlePrice !== null) {
    return candlePrice;
  }

  if (!preferLive) {
    return fetchLatestOptionQuote(contract);
  }

  return null;
}

async function resolveCurrentExpiryOptionContract({ symbol, direction, spotPrice, tradeDate }) {
  const config = getIndexOptionConfig(symbol);
  if (!config) return null;

  const suffix = direction === "CALL" ? "CE" : "PE";
  const instruments = Object.values(symbolToTokenMap).filter((instrument) =>
    instrument.name === config.instrumentName &&
    instrument.segment === config.segment &&
    instrument.instrumenttype === "OPTIDX" &&
    instrument.symbol.endsWith(suffix)
  );

  if (instruments.length === 0) {
    try {
      await loadScripMaster();
    } catch (err) {
      return null;
    }
  }

  const refreshedInstruments = Object.values(symbolToTokenMap).filter((instrument) =>
    instrument.name === config.instrumentName &&
    instrument.segment === config.segment &&
    instrument.instrumenttype === "OPTIDX" &&
    instrument.symbol.endsWith(suffix)
  );

  if (refreshedInstruments.length === 0) return null;

  const ongoingExpiry = getOngoingExpiry(refreshedInstruments, tradeDate ? new Date(tradeDate) : new Date());
  if (!ongoingExpiry) return null;

  const expiryInstruments = refreshedInstruments.filter((instrument) => {
    const expiryDate = parseExpiryDate(instrument.expiry);
    return expiryDate && expiryDate.getTime() === ongoingExpiry.getTime();
  });

  if (expiryInstruments.length === 0) return null;

  const selected = pickAtmStrikeInstrument(expiryInstruments, spotPrice, config.strikeStep);
  if (!selected) return null;

  const optionName = `${symbol} ${selected.strikePrice} ${suffix}`;
  return {
    ...selected,
    exchange: config.exchange,
    optionName
  };
}

module.exports = {
  resolveCurrentExpiryOptionContract,
  getOptionPriceAt,
  fetchLatestOptionQuote
};
