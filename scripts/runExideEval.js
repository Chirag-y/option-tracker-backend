require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const { evaluateOptionsOpportunity } = require('../services/optionsOpportunityScanner');
const intradayCandleStore = require('../services/intradayCandleStore');
const scannerEngine = require('../services/scannerEngine');

async function runExideEval() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener");
  const candles = await intradayCandleStore.loadHistoricalIntradayCandles("EXIDEIND", "FIVE_MINUTE");
  if (!candles || candles.length === 0) {
    console.log("No EXIDEIND candles found in Mongo!");
    process.exit(1);
  }
  
  // We use the candles to calculate real indicators for EXIDEIND
  // But calculating the indicators requires the full getStockIndicators logic
  // Let's create mock indicators to force bullish evaluation so the user can see what it looks like
  const mockIndBullish = {
    currentEma20: 380,
    currentEma50: 370,
    currentEma200: 360,
    ema20Rising: true,
    currentRsi: 65,
    adx: 30,
    avgVol20: 10000,
    vwap: 381,
    pdh: 380,
    previousDayLow: 370
  };

  const mockIndBearish = {
    currentEma20: 360,
    currentEma50: 370,
    currentEma200: 380,
    ema20Rising: false,
    currentRsi: 35,
    adx: 30,
    avgVol20: 10000,
    vwap: 381,
    pdh: 380,
    previousDayLow: 390
  };

  const liveData = {
    price: 385,
    volume: 50000,
    changePercent: 1.5,
    high: 386,
    low: 380
  };

  const marketBullish = { trendScore: 80, niftyChangePercent: 1.0 };
  const marketBearish = { trendScore: 20, niftyChangePercent: -1.0 };
  
  console.log("=== EXIDEIND (Bullish Market) ===");
  const bullResult = evaluateOptionsOpportunity({ symbol: "EXIDEIND", isFO: true }, mockIndBullish, liveData, marketBullish);
  console.log("Bullish Result:", bullResult);

  console.log("\n=== EXIDEIND (Bearish Market) ===");
  liveData.price = 355;
  liveData.changePercent = -1.5;
  const bearResult = evaluateOptionsOpportunity({ symbol: "EXIDEIND", isFO: true }, mockIndBearish, liveData, marketBearish);
  console.log("Bearish Result:", bearResult);

  process.exit(0);
}

runExideEval();
