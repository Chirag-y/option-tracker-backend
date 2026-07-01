require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { evaluateOptionsOpportunity } = require('../services/optionsOpportunityScanner');
const { calculateMomentumTrackerV10 } = require('../services/momentumTracker');
const intradayCandleStore = require('../services/intradayCandleStore');
const scannerEngine = require('../services/scannerEngine');
const FoActiveTrade = require('../models/FoActiveTrade');

async function seedHistory() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener");
  
  await FoActiveTrade.deleteMany({});
  console.log("Cleared FoActiveTrade collection");

  const dailyPath = path.join(__dirname, '../config/historicalDailyCandles.json');
  const dailyData = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
  
  const fnoUniversePath = path.join(__dirname, '../config/scripMaster.json');
  const fnoData = JSON.parse(fs.readFileSync(fnoUniversePath, 'utf8'));
  const foSymbols = [...new Set(fnoData.filter(s => s.instrumenttype === "OPTSTK" || s.instrumenttype === "FUTSTK").map(s => s.name))];
  
  console.log(`Testing ${foSymbols.length} F&O symbols...`);
  
  let inserted = 0;
  const marketOverview = { trendScore: 80, niftyChangePercent: 1.0 };
  
  for (const symbol of foSymbols) {
    if (!dailyData[symbol]) continue;
    
    let intradayCandles = [];
    try {
      intradayCandles = await intradayCandleStore.loadHistoricalIntradayCandles(symbol, 'FIVE_MINUTE');
    } catch(e) { continue; }
    
    if (!intradayCandles || intradayCandles.length < 50) continue;
    
    let ind = scannerEngine.getStockIndicators(dailyData[symbol]);
    let stock = { symbol: symbol, name: symbol, isFO: true };
    
    let startIdx = intradayCandles.length - (75 * 7); // ~7 days back
    if (startIdx < 0) startIdx = 0;
    
    for (let i = startIdx; i < intradayCandles.length; i++) {
      const candle = intradayCandles[i];
      const dt = new Date(candle.date);
      if (dt.getHours() === 9 && dt.getMinutes() < 20) continue;
      
      // Get daily candles up to this date
      const dailyCandlesForStock = dailyData[symbol];
      const sliceDaily = dailyCandlesForStock.filter(c => new Date(c.date) <= dt);
      if (sliceDaily.length < 50) continue;
      
      // Calculate indicators exactly as they were at this point in time
      let ind = scannerEngine.getStockIndicators(sliceDaily);
      let stock = { symbol: symbol, name: symbol, isFO: true };
      
      const slice = intradayCandles.slice(0, i+1);
      const liveData = { price: candle.close, ltp: candle.close, volume: candle.volume };
      
      const optResult = evaluateOptionsOpportunity(stock, ind, liveData, marketOverview);
      const momResultArray = calculateMomentumTrackerV10(slice);
      const lastMom = momResultArray.length > 0 ? momResultArray[momResultArray.length - 1] : null;
      
      let triggeredOpt = optResult && optResult.triggered;
      if (triggeredOpt) {
        let scannerId = optResult.direction === "BULLISH" ? "options-bullish" : "options-bearish";
        const newTrade = new FoActiveTrade({
          scannerId: scannerId,
          symbol: symbol,
          entryPrice: candle.close,
          direction: optResult.direction,
          strengthScore: optResult.strengthScore,
          status: "CLOSED",
          createdAt: dt,
          triggeredAt: dt,
          closedAt: new Date(dt.getTime() + 1000 * 60 * 60 * 24),
          pnlPct: 2.5,
          breakdown: optResult.reasons
        });
        await newTrade.save();
        inserted++;
        i += 75; // Skip the rest of the day
        continue;
      }
      
      let triggeredMom = lastMom && (lastMom.signal === "LONG" || lastMom.signal === "SHORT");
      if (triggeredMom) {
        let direction = lastMom.signal === "LONG" ? "BULLISH" : "BEARISH";
        let scannerId = direction === "BULLISH" ? "fo-bullish" : "fo-bearish";
        const newTrade = new FoActiveTrade({
          scannerId: scannerId,
          symbol: symbol,
          entryPrice: candle.close,
          direction: direction,
          strengthScore: 70, // arbitrary default score > 65
          status: "CLOSED",
          createdAt: dt,
          triggeredAt: dt,
          closedAt: new Date(dt.getTime() + 1000 * 60 * 60 * 24),
          pnlPct: 2.5,
          breakdown: ["Momentum Tracker V10 Signal Triggered"]
        });
        await newTrade.save();
        inserted++;
        i += 75; // Skip the rest of the day
      }
    }
  }
  
  console.log(`Inserted ${inserted} closed signals into FoActiveTrade!`);
  process.exit(0);
}

seedHistory();
