const fs = require("fs");
const path = require("path");
const { buildUnifiedIndexCandles } = require("../services/scannerEngine");
const { generateIndexTrades } = require("../services/hullScanner");

const intradayCandlesCachePath = "D:\\MERN\\Option Tracker\\backend\\config\\historicalIntradayCandles.json";
const historicalIntradayCandles = JSON.parse(fs.readFileSync(intradayCandlesCachePath, "utf-8"));

const indexData = historicalIntradayCandles["Nifty 50"] || {};
let oneMin = indexData["ONE_MINUTE"] || [];
let threeMin = indexData["THREE_MINUTE"] || [];

const unifiedCandles = buildUnifiedIndexCandles(oneMin, threeMin);

// Let's run a custom version of trade generation to debug the signal conditions on Friday
const closes = unifiedCandles.map(c => c.close);
const { EHMA } = require("../services/hullScanner");
const hull = EHMA(closes, 16);

console.log("Nifty Signals on June 19:");
for (let i = 3; i < unifiedCandles.length; i++) {
  const close = unifiedCandles[i].close;
  const date = unifiedCandles[i].date;
  if (!date.includes("2026-06-19")) continue;

  const mhull = hull[i];
  const shull = hull[i - 2];
  const prevHull = hull[i - 1];
  if (mhull === null || shull === null || prevHull === null) continue;

  const buySignal = hull[i - 2] >= hull[i - 1] && shull < mhull;
  const sellSignal = hull[i - 2] <= hull[i - 1] && shull > mhull;

  if (buySignal) {
    const isStrong = close > mhull && close > shull;
    console.log(`${date} [CALL] Close:${close} mHull:${mhull.toFixed(2)} sHull:${shull.toFixed(2)} -> ${isStrong ? "STRONG" : "RISKY"}`);
  }
  if (sellSignal) {
    const isStrong = close < mhull && close < shull;
    console.log(`${date} [PUT]  Close:${close} mHull:${mhull.toFixed(2)} sHull:${shull.toFixed(2)} -> ${isStrong ? "STRONG" : "RISKY"}`);
  }
}
