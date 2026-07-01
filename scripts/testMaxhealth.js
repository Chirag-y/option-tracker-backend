require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { evaluateOptionsOpportunity } = require('../services/optionsOpportunityScanner');
const { calculateMomentumTrackerV10 } = require('../services/momentumTracker');
const intradayCandleStore = require('../services/intradayCandleStore');
const scannerEngine = require('../services/scannerEngine');

async function testMaxhealth() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener");
  const symbol = "MAXHEALTH";
  
  const dailyCandleStore = require('../services/dailyCandleStore');
  
  
  let intradayCandles = [];
  try {
    intradayCandles = await intradayCandleStore.loadHistoricalIntradayCandles(symbol, 'FIVE_MINUTE');
  } catch(e) { 
    console.error("Failed to load intraday for", symbol);
    return;
  }
  
  if (!intradayCandles || intradayCandles.length < 50) {
    console.log("Not enough intraday candles for", symbol);
    return;
  }
  
  let startIdx = intradayCandles.length - (75 * 7); // ~7 days back
  if (startIdx < 0) startIdx = 0;
  
  console.log(`Starting scan for ${symbol} over last 7 days...`);
  const marketOverview = { trendScore: 80, niftyChangePercent: 1.0 }; let dailyCandlesForStock = await dailyCandleStore.loadSeries(symbol); if (!dailyCandlesForStock || dailyCandlesForStock.length < 50) dailyCandlesForStock = await dailyCandleStore.loadSeries(symbol + '-EQ');
  let foundSignals = [];
  
  for (let i = startIdx; i < intradayCandles.length; i++) {
    const candle = intradayCandles[i];
    const dt = new Date(candle.date);
    if (dt.getHours() === 9 && dt.getMinutes() < 20) continue;
    
    const slice = intradayCandles.slice(0, i+1);
    const liveData = { price: candle.close, ltp: candle.close, volume: candle.volume };
    
    // Evaluate Options Scanners
    
    const sliceDaily = dailyCandlesForStock.filter(c => new Date(c.date) <= dt);
    if (sliceDaily.length < 50) continue;
    
    let ind = scannerEngine.getStockIndicators(sliceDaily);
    let stock = { symbol: symbol, name: symbol, isFO: true };
    
    console.log(ind.currentEma20, ind.currentEma50, ind.currentEma200); const optResult = evaluateOptionsOpportunity(stock, ind, liveData, marketOverview); if(optResult) console.log(dt, optResult);
    if (optResult && optResult.triggered) {
      let scannerId = optResult.direction === "BULLISH" ? "options-bullish" : "options-bearish";
      foundSignals.push({
        scanner: scannerId,
        time: dt.toISOString(),
        price: candle.close,
        score: optResult.strengthScore,
        reasons: optResult.reasons
      });
    }
    
    // Evaluate F&O Momentum Scanners
    const momResultArray = calculateMomentumTrackerV10(slice); if (momResultArray.length && momResultArray[momResultArray.length-1].signal !== 'NEUTRAL') console.log(dt, momResultArray[momResultArray.length-1]);
    const lastMom = momResultArray.length > 0 ? momResultArray[momResultArray.length - 1] : null;
    
    if (lastMom && (lastMom.signal === "LONG" || lastMom.signal === "SHORT")) {
      let direction = lastMom.signal === "LONG" ? "BULLISH" : "BEARISH";
      let scannerId = direction === "BULLISH" ? "fo-bullish" : "fo-bearish";
      foundSignals.push({
        scanner: scannerId,
        time: dt.toISOString(),
        price: candle.close,
        score: "N/A",
        reasons: ["Momentum Tracker V10 Signal"]
      });
    }
  }
  
  console.log(`Found ${foundSignals.length} signals for ${symbol} over the last 7 days:`);
  console.log(JSON.stringify(foundSignals, null, 2));
  process.exit(0);
}

testMaxhealth();
