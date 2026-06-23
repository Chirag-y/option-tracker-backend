const fs = require("fs");
const path = require("path");

const intradayCandlesCachePath = path.join(__dirname, "../config/historicalIntradayCandles.json");
const historicalIntradayCandles = JSON.parse(fs.readFileSync(intradayCandlesCachePath, "utf-8"));

const scannerEngine = require("../services/scannerEngine");
scannerEngine.getHistoricalIntradayCandles = () => historicalIntradayCandles;

const { runBacktest } = require("../services/backtestEngine");

async function test() {
  const res = await runBacktest("nifty-signals");
  console.log("Win rate:", res.stats.winRate);
  console.log("Total trades:", res.trades.length);
  if (res.trades.length > 0) {
    console.log("Sample trade:", res.trades[0]);
  }
}

test().catch(console.error);
