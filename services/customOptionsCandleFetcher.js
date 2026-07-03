/**
 * Rate-limited, cached candle fetcher for Custom Options (Angel SmartAPI).
 * Angel returns HTTP-style status 403 when historical requests are sent too quickly.
 */
const smartApiSession = require("./smartApiSession");
const { getCandleDataQueued } = require("./globalCandleApiQueue");

const CACHE_TTL_MS = 5 * 60_000;
const LIVE_CACHE_TTL_MS = 90_000;
const MIN_GAP_MS = 3_000;
const MAX_RETRIES = 6;

const candleCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapSmartApiBody(response) {
  if (!response) return null;
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.data)) return response.data;
  if (response.data?.data && Array.isArray(response.data.data)) return response.data.data;
  if (response.data?.candles && Array.isArray(response.data.candles)) return response.data.candles;
  return null;
}

function mapCandleRows(rows) {
  return rows.map((c) => ({
    date: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseInt(c[5], 10) || 0,
  }));
}

function formatDay(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function mergeCandles(chunks) {
  const byTs = new Map();
  for (const c of chunks) {
    const ts = new Date(c.date).getTime();
    if (!Number.isFinite(ts)) continue;
    byTs.set(ts, c);
  }
  return [...byTs.values()].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

async function ensureSmartApiReady() {
  if (!smartApiSession.getSmartApiInstance()) {
    await smartApiSession.initializeSession();
  }
}

async function fetchDayCandles(api, exchange, token, interval, dayStr, symbolKey) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getCandleDataQueued({
        exchange,
        symboltoken: token,
        interval,
        fromdate: `${dayStr} 09:15`,
        todate: `${dayStr} 15:30`,
      }, { label: `${symbolKey}:${interval}:${dayStr}` });

      const rows = unwrapSmartApiBody(response);
      if (rows?.length) return mapCandleRows(rows);

      const status = response?.status ?? response?.data?.status;
      const isRateLimited = status === 403 || status === 429 || status === false;
      if (isRateLimited && attempt < MAX_RETRIES - 1) {
        const backoff = MIN_GAP_MS * (attempt + 2);
        if (attempt === 0) {
          console.warn(
            `[CustomOptionsCandles] Broker rate limit — ${symbolKey} ${interval} ${dayStr}, retrying…`
          );
        }
        await sleep(backoff);
        continue;
      }

      return [];
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        await sleep(MIN_GAP_MS * (attempt + 2));
        continue;
      }
      console.error(`[CustomOptionsCandles] Fetch error ${symbolKey} ${interval} ${dayStr}:`, err.message);
      return [];
    }
  }
  return [];
}

/**
 * Fetch intraday candles day-by-day (avoids Angel empty/403 responses on wide ranges).
 */
async function fetchCustomOptionsCandles(symbolKey, token, segment, interval, lookbackDays = 3) {
  const cacheKey = `${symbolKey}|${interval}|${lookbackDays}`;
  const cached = candleCache.get(cacheKey);
  const ttl = lookbackDays <= 1 ? LIVE_CACHE_TTL_MS : CACHE_TTL_MS;
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return cached.candles;
  }

  await ensureSmartApiReady();
  const api = smartApiSession.getSmartApiInstance();
  if (!api) throw new Error("SmartAPI not initialized");

  const exchange = segment === "BSE" || segment === "BFO" ? "BFO" : "NFO";
  const today = new Date();
  const allChunks = [];

  for (let offset = lookbackDays; offset >= 0; offset--) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const dayStr = formatDay(day);
    const dayCandles = await fetchDayCandles(api, exchange, token, interval, dayStr, symbolKey);
    if (dayCandles.length) allChunks.push(...dayCandles);
  }

  const merged = mergeCandles(allChunks);
  if (merged.length) {
    candleCache.set(cacheKey, { fetchedAt: Date.now(), candles: merged });
  }

  return merged;
}

function invalidateCache(symbolKey) {
  for (const key of candleCache.keys()) {
    if (key.startsWith(`${symbolKey}|`)) candleCache.delete(key);
  }
}

module.exports = {
  fetchCustomOptionsCandles,
  invalidateCache,
};
