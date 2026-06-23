const fs = require("fs");
const path = require("path");
const { buildUnifiedIndexCandles } = require("../services/scannerEngine");
const { generateIndexTrades } = require("../services/hullScanner");

// read cache directly
const intradayCandlesCachePath = path.join(__dirname, "../config/historicalIntradayCandles.json");
const historicalIntradayCandles = JSON.parse(fs.readFileSync(intradayCandlesCachePath, "utf-8"));

const indexData = historicalIntradayCandles["Nifty 50"] || {};
let oneMin = indexData["ONE_MINUTE"] || [];
let threeMin = indexData["THREE_MINUTE"] || [];

const unifiedCandles = buildUnifiedIndexCandles(oneMin, threeMin);
const trades = generateIndexTrades(unifiedCandles, 30, 30);

console.log("Total trades generated:", trades.length);
if (trades.length > 0) {
  console.log("Sample trade 0:", trades[0]);
  console.log("Sample trade last:", trades[trades.length - 1]);
}
