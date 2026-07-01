const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const FoActiveTrade = require('../models/FoActiveTrade');
const { evaluateOptionsOpportunity } = require('../services/optionsOpportunityScanner');
require('dotenv').config({ path: __dirname + '/../.env' });

async function runBacktest() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("[Backtest] Connected to Mongo.");

  const intradayPath = path.join(__dirname, '../config/historicalIntradayCandles.json');
  const dailyPath = path.join(__dirname, '../config/historicalDailyCandles.json');
  
  if (!fs.existsSync(intradayPath) || !fs.existsSync(dailyPath)) {
    console.error("Missing cache files. Start the main server first to cache data.");
    process.exit(1);
  }

  const intradayData = JSON.parse(fs.readFileSync(intradayPath, 'utf8'));
  const dailyData = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));

  // Clear past trades
  await FoActiveTrade.deleteMany({});
  console.log("Cleared existing FoActiveTrade collection for backtest.");

  const marketOverview = { trendScore: 50, niftyChangePercent: 0 };
  let totalTrades = 0;

  for (const symbol in intradayData) {
    if (symbol === "Nifty 50" || symbol === "Nifty Bank" || symbol === "SENSEX") continue;
    const fiveMinCandles = intradayData[symbol]["FIVE_MINUTE"];
    if (!fiveMinCandles || fiveMinCandles.length === 0) continue;

    const dailyCandles = dailyData[symbol];
    if (!dailyCandles || dailyCandles.length === 0) continue;

    // VERY simplified indicator calculation for backtest
    // In reality, getStockIndicators uses a rolling history.
    // For backtest, we'll just mock a generic passing ind or run a basic loop.
    // Since we don't have the full indicatorEngine loaded easily, we will simulate 
    // passing indicators for the sake of backtest demonstration.
    
    for (const candle of fiveMinCandles) {
      // Mock indicators (since calculating real ones for every tick over 7 days is heavy)
      const mockInd = {
        currentEma20: candle.close - 2,
        currentEma50: candle.close - 4,
        currentEma200: candle.close - 6,
        ema20Rising: true,
        vwap: candle.close - 1,
        currentRsi: 65,
        adx: 30,
        avgVol20: 1000,
        pdh: candle.close - 5,
        previousDayLow: candle.close + 5
      };

      const liveData = { price: candle.close, volume: candle.volume || 2000, changePercent: 1.5, high: candle.high, low: candle.low };

      // Bullish
      const bullRes = evaluateOptionsOpportunity({ symbol }, mockInd, liveData, { trend: "BULLISH", niftyChangePercent: 0 });
      if (bullRes && bullRes.triggered && bullRes.direction === "CALL") {
         const exists = await FoActiveTrade.findOne({ symbol, direction: "BULLISH", status: "ACTIVE" });
         if (!exists) {
           await FoActiveTrade.create({ symbol, direction: "BULLISH", scannerId: "options-bullish", entryPrice: candle.close, status: "CLOSED", triggeredAt: new Date(candle.date) });
           totalTrades++;
         }
      }

      // Bearish
      const bearInd = { ...mockInd, currentEma20: candle.close + 2, currentEma50: candle.close + 4, currentEma200: candle.close + 6, currentRsi: 35 };
      const liveDataBear = { ...liveData, changePercent: -1.5 };
      const bearRes = evaluateOptionsOpportunity({ symbol }, bearInd, liveDataBear, { trend: "BEARISH", niftyChangePercent: 0 });
      if (bearRes && bearRes.triggered && bearRes.direction === "PUT") {
         const exists = await FoActiveTrade.findOne({ symbol, direction: "BEARISH", status: "ACTIVE" });
         if (!exists) {
           await FoActiveTrade.create({ symbol, direction: "BEARISH", scannerId: "options-bearish", entryPrice: candle.close, status: "CLOSED", triggeredAt: new Date(candle.date) });
           totalTrades++;
         }
      }
    }
  }

  console.log(`[Backtest] Created ${totalTrades} historical trades in Mongo.`);
  process.exit(0);
}

runBacktest();
