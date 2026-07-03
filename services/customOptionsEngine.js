const CustomOptionsSignal = require("../models/CustomOptionsSignal");
const { enableCustomOptionsScanner } = require("../config/runtimeFlags");
const User = require("../models/User");
const aoScanner = require("./aoScanner");
const { resolveOptionInstrument, parseExpiry } = require("./customOptionsStrikeCatalog");
const { notifyUsersForCustomOptionsSignal } = require("../utils/customOptionsNotify");
const { fetchCustomOptionsCandles } = require("./customOptionsCandleFetcher");
const {
  beginCustomOptionsHistoricalFetch,
  endCustomOptionsHistoricalFetch,
  isScannerIntradayPreloadPaused,
} = require("./apiQuotaGuard");

const ACTIONABLE_SIGNALS = new Set([
  "BUY", "SELL", "EXIT", "SL_HIT", "CONFLUENCE_BREAK", "OPPOSITE_TRADE",
]);

async function fetchHistoricalCustomOptionsFromAPI(symbolKey, token, segment, interval, lookbackDays = 3) {
  try {
    const candles = await fetchCustomOptionsCandles(symbolKey, token, segment, interval, lookbackDays);
    if (candles.length === 0) {
      console.warn(`[CustomOptionsEngine] No candles returned for ${symbolKey} ${interval} after ${lookbackDays + 1} day fetches`);
    }
    return candles;
  } catch (err) {
    console.error(`[CustomOptionsEngine] API fetch error for ${symbolKey}:`, err.message);
    return [];
  }
}

function expiryDateFromInstrument(instrument) {
  const parsed = parseExpiry(instrument?.expiry);
  if (parsed) return parsed;
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

let liveScanRunning = false;
let historicalFetchInProgress = false;
let liveScanPausedUntil = 0;

const LIVE_LOOKBACK_DAYS = 1;
const LIVE_SCAN_PAUSE_MS = 5 * 60 * 1000;

async function processCustomOptionsHistoricalData(callStrike, putStrike) {
  historicalFetchInProgress = true;
  beginCustomOptionsHistoricalFetch();
  try {
  console.log(`[CustomOptionsEngine] Processing historical data for: ${callStrike} & ${putStrike}`);
  const strikes = [callStrike, putStrike].filter(Boolean);
  const summary = { symbols: {}, totalSaved: 0 };

  // Keep warm cache when re-running the same strikes — avoids redundant API calls.

  // Remove noisy per-minute ACTIVE rows from prior runs
  try {
    const removed = await CustomOptionsSignal.deleteMany({
      symbol: { $in: strikes },
      signal: "ACTIVE",
    });
    if (removed.deletedCount > 0) {
      console.log(`[CustomOptionsEngine] Purged ${removed.deletedCount} ACTIVE rows for selected strikes`);
    }
  } catch (err) {
    console.warn("[CustomOptionsEngine] ACTIVE cleanup failed:", err.message);
  }

  for (const strike of strikes) {
    summary.symbols[strike] = { saved: 0, candles: 0, error: null };
    const instrument = resolveOptionInstrument(strike);
    if (!instrument) {
      console.warn(`[CustomOptionsEngine] Token not found for ${strike}`);
      summary.symbols[strike].error = "token_not_found";
      continue;
    }

    const contractExpiry = expiryDateFromInstrument(instrument);
    const timeframes = ["ONE_MINUTE", "THREE_MINUTE"];

    for (const timeframe of timeframes) {
      const tfCode = timeframe === "ONE_MINUTE" ? "1M" : "3M";
      const lastSignal = await CustomOptionsSignal.findOne({ symbol: strike, timeframe: tfCode })
        .sort({ timestamp: -1 });

      console.log(`[CustomOptionsEngine] Fetching ${strike} ${tfCode} (3-day history)...`);
      const fullFetchedCandles = await fetchHistoricalCustomOptionsFromAPI(
        strike, instrument.token, instrument.segment, timeframe, 3
      );

      summary.symbols[strike].candles = Math.max(summary.symbols[strike].candles, fullFetchedCandles.length);

      if (fullFetchedCandles.length < 35) {
        console.warn(`[CustomOptionsEngine] Insufficient candles (${fullFetchedCandles.length}) for ${strike} ${tfCode}`);
        summary.symbols[strike].error = summary.symbols[strike].error || `insufficient_${tfCode}`;
        continue;
      }

      let activeTrade = null;
      if (lastSignal && (lastSignal.signal === "BUY" || lastSignal.signal === "ACTIVE")) {
        activeTrade = { entryPrice: lastSignal.ltp };
      }

      const signalsToSave = [];

      for (let i = 35; i < fullFetchedCandles.length; i++) {
        const slice = fullFetchedCandles.slice(0, i + 1);
        const currentCandle = slice[slice.length - 1];
        const candleTime = new Date(currentCandle.date).getTime();

        if (lastSignal && candleTime <= lastSignal.timestamp.getTime()) continue;

        const result = aoScanner.evaluateCustomOptionsStrategy(slice, activeTrade);
        if (!result.signal || !ACTIONABLE_SIGNALS.has(result.signal)) {
          if (result.signal === "ACTIVE") continue;
          continue;
        }

        if (result.signal === "BUY") {
          activeTrade = { entryPrice: result.ltp };
        } else if (["SL_HIT", "CONFLUENCE_BREAK", "OPPOSITE_TRADE"].includes(result.signal)) {
          activeTrade = null;
        }

        signalsToSave.push({
          symbol: strike,
          timeframe: tfCode,
          date: currentCandle.date,
          timestamp: new Date(currentCandle.date),
          signal: result.signal,
          ltp: result.ltp,
          ao: result.ao,
          macdLine: result.macdLine,
          macdSignal: result.macdSignal,
          rsi: result.rsi,
          sma18: result.sma18,
          sma18_prev: result.sma18_prev,
          isHistorical: true,
          expiry: contractExpiry,
        });
      }

      if (signalsToSave.length > 0) {
        try {
          await CustomOptionsSignal.insertMany(signalsToSave, { ordered: false });
          console.log(`[CustomOptionsEngine] Saved ${signalsToSave.length} signals for ${strike} ${tfCode}`);
          summary.symbols[strike].saved += signalsToSave.length;
          summary.totalSaved += signalsToSave.length;
        } catch (e) {
          if (e.code !== 11000) console.error("[CustomOptionsEngine] Mongo insert error:", e.message);
        }
      } else {
        console.log(`[CustomOptionsEngine] No new actionable signals for ${strike} ${tfCode}`);
      }
    }
  }

  console.log(`[CustomOptionsEngine] Done. Total saved: ${summary.totalSaved}`);
  liveScanPausedUntil = Date.now() + LIVE_SCAN_PAUSE_MS;
  console.log(`[CustomOptionsEngine] Live scan paused ${LIVE_SCAN_PAUSE_MS / 1000}s to avoid broker rate limits`);
  return summary;
  } finally {
    historicalFetchInProgress = false;
    endCustomOptionsHistoricalFetch();
  }
}

function isIndianMarketOpen() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

async function evaluateLatestCandleForStrike(strike, interval, tfCode) {
  const instrument = resolveOptionInstrument(strike);
  if (!instrument) return null;

  const contractExpiry = expiryDateFromInstrument(instrument);
  const lastSignal = await CustomOptionsSignal.findOne({ symbol: strike, timeframe: tfCode })
    .sort({ timestamp: -1 });

  const candles = await fetchHistoricalCustomOptionsFromAPI(
    strike, instrument.token, instrument.segment, interval, LIVE_LOOKBACK_DAYS
  );
  if (candles.length < 36) return null;

  const currentCandle = candles[candles.length - 1];
  const candleTime = new Date(currentCandle.date).getTime();
  if (lastSignal && candleTime <= lastSignal.timestamp.getTime()) return null;

  let activeTrade = null;
  if (lastSignal && (lastSignal.signal === "BUY" || lastSignal.signal === "ACTIVE")) {
    activeTrade = { entryPrice: lastSignal.ltp };
  }

  const result = aoScanner.evaluateCustomOptionsStrategy(candles, activeTrade);
  if (!result.signal || !ACTIONABLE_SIGNALS.has(result.signal)) return null;

  const signalDoc = {
    symbol: strike,
    timeframe: tfCode,
    date: currentCandle.date,
    timestamp: new Date(currentCandle.date),
    signal: result.signal,
    ltp: result.ltp,
    ao: result.ao,
    macdLine: result.macdLine,
    macdSignal: result.macdSignal,
    rsi: result.rsi,
    sma18: result.sma18,
    sma18_prev: result.sma18_prev,
    isHistorical: false,
    expiry: contractExpiry,
  };

  try {
    await CustomOptionsSignal.create(signalDoc);
    console.log(`[CustomOptionsEngine] Live signal ${signalDoc.signal} for ${strike} ${tfCode}`);
    await notifyUsersForCustomOptionsSignal(signalDoc);
    return signalDoc;
  } catch (e) {
    if (e.code !== 11000) console.error("[CustomOptionsEngine] Live signal save error:", e.message);
    return null;
  }
}

async function runLiveCustomOptionsScan() {
  if (!isIndianMarketOpen()) return;

  const users = await User.find({
    customOptionsAlertsEnabled: true,
    isVerified: true,
    isTeamApproved: { $ne: false },
    $or: [
      { customOptionsCallStrike: { $nin: [null, ""] } },
      { customOptionsPutStrike: { $nin: [null, ""] } },
    ],
  }).select("customOptionsCallStrike customOptionsPutStrike").lean();

  const symbols = new Set();
  for (const u of users) {
    if (u.customOptionsCallStrike) symbols.add(u.customOptionsCallStrike);
    if (u.customOptionsPutStrike) symbols.add(u.customOptionsPutStrike);
  }
  if (!symbols.size) return;

  for (const strike of symbols) {
    for (const [interval, tfCode] of [["ONE_MINUTE", "1M"], ["THREE_MINUTE", "3M"]]) {
      try {
        await evaluateLatestCandleForStrike(strike, interval, tfCode);
      } catch (err) {
        console.error(`[CustomOptionsEngine] Live scan error ${strike} ${tfCode}:`, err.message);
      }
    }
  }
}

async function tickLiveCustomOptionsScan() {
  if (liveScanRunning || historicalFetchInProgress || !isIndianMarketOpen()) return;
  if (Date.now() < liveScanPausedUntil) return;
  if (isScannerIntradayPreloadPaused()) return;
  liveScanRunning = true;
  try {
    await runLiveCustomOptionsScan();
  } finally {
    liveScanRunning = false;
  }
}

async function cleanupExpiredSignals() {
  try {
    const now = new Date();
    const result = await CustomOptionsSignal.deleteMany({ expiry: { $lt: now } });
    if (result.deletedCount > 0) {
      console.log(`[CustomOptionsEngine] Cleaned up ${result.deletedCount} expired signals from MongoDB.`);
    }
  } catch (err) {
    console.error(`[CustomOptionsEngine] Error cleaning up expired signals:`, err.message);
  }
}

if (enableCustomOptionsScanner) {
  setInterval(tickLiveCustomOptionsScan, 90 * 1000);
  setInterval(cleanupExpiredSignals, 12 * 60 * 60 * 1000);
  cleanupExpiredSignals();
} else {
  console.log("[CustomOptionsEngine] Live scanner disabled by runtime flags.");
}

module.exports = {
  processCustomOptionsHistoricalData,
  cleanupExpiredSignals,
  runLiveCustomOptionsScan,
};
