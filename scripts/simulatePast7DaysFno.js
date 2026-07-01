require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { evaluateOptionsOpportunity } = require('../services/optionsOpportunityScanner');
const { calculateMomentumTrackerV10 } = require('../services/momentumTracker');
const intradayCandleStore = require('../services/intradayCandleStore');
const dailyCandleStore = require('../services/dailyCandleStore');
const scannerEngine = require('../services/scannerEngine');
const FoActiveTrade = require('../models/FoActiveTrade');

async function simulate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  // Clear existing F&O trades to ensure no mock data
  await FoActiveTrade.deleteMany({});
  console.log("Cleared existing FoActiveTrade collection");

  const fnoUniversePath = path.join(__dirname, '../config/scripMaster.json');
  const fnoData = JSON.parse(fs.readFileSync(fnoUniversePath, 'utf8'));
  const fnoStocks = fnoData.filter(s => s.instrumenttype === "OPTSTK" || s.instrumenttype === "FUTSTK");
  const uniqueNames = [...new Set(fnoStocks.map(s => s.name))];

  console.log(`Starting historical simulation for ${uniqueNames.length} F&O stocks...`);
  
  const marketOverview = { trendScore: 80, niftyChangePercent: 0.5 };
  let totalSignals = 0;

  for (let i = 0; i < uniqueNames.length; i++) {
    const symbol = uniqueNames[i];
    console.log(`Processing [${i+1}/${uniqueNames.length}] ${symbol}...`);
    
    // Load data from Mongo
    const intradayCandles = await intradayCandleStore.loadHistoricalIntradayCandles(symbol, 'FIVE_MINUTE');
    let dailyCandlesForStock = await dailyCandleStore.loadSeries(symbol); if (!dailyCandlesForStock || dailyCandlesForStock.length < 50) dailyCandlesForStock = await dailyCandleStore.loadSeries(symbol + '-EQ');

    if (!intradayCandles || intradayCandles.length < 50 || !dailyCandlesForStock || dailyCandlesForStock.length < 50) {
      continue;
    }

    let startIdx = intradayCandles.length - (75 * 7); // ~7 days back
    if (startIdx < 0) startIdx = 0;

    let activeTrades = {};

    for (let j = startIdx; j < intradayCandles.length; j++) {
      const candle = intradayCandles[j];
      const dt = new Date(candle.date);
      
      // 0. Simulate exits (Target, SL, or EOD 15:25) BEFORE new entries
      for (const key of Object.keys(activeTrades)) {
        const tr = activeTrades[key];
        
        let exitReason = null;
        let exitPrice = null;
        const isEod = dt.getHours() === 15 && dt.getMinutes() >= 25;
        
        if (isEod) {
          exitReason = "Day End Exit";
          exitPrice = candle.close;
        } else if (tr.direction === "BULLISH" || tr.direction === "CALL") {
          if (candle.high >= tr.entryPrice * 1.025) { exitReason = "Target Hit"; exitPrice = tr.entryPrice * 1.025; }
          else if (candle.low <= tr.entryPrice * 0.98) { exitReason = "Stop Loss Hit"; exitPrice = tr.entryPrice * 0.98; }
        } else {
          if (candle.low <= tr.entryPrice * 0.975) { exitReason = "Target Hit"; exitPrice = tr.entryPrice * 0.975; }
          else if (candle.high >= tr.entryPrice * 1.02) { exitReason = "Stop Loss Hit"; exitPrice = tr.entryPrice * 1.02; }
        }
            
        if (exitReason) {
          const profitPct = (tr.direction === "BULLISH" || tr.direction === "CALL") 
              ? (exitPrice - tr.entryPrice) / tr.entryPrice
              : (tr.entryPrice - exitPrice) / tr.entryPrice;
              
          tr.status = "CLOSED";
          tr.closedAt = dt;
          tr.exitPrice = exitPrice;
          tr.pnlPct = profitPct * 100;
          tr.reasons.push(exitReason);
          await tr.save();
          delete activeTrades[key];
        }
      }

      // Skip very early morning candles for stability, and skip new entries EOD
      if (dt.getHours() === 9 && dt.getMinutes() < 25) continue;
      if (dt.getHours() === 15 && dt.getMinutes() >= 20) continue;

      const slice = intradayCandles.slice(0, j + 1);
      const liveData = { price: candle.close, ltp: candle.close, volume: candle.volume, high: candle.high, low: candle.low, changePercent: 0 };
      const sliceDaily = dailyCandlesForStock.filter(c => new Date(c.date) <= dt).slice(-250); 
      
      if (sliceDaily.length < 50) continue;

      const ind = scannerEngine.getStockIndicators(sliceDaily);
      const stock = { symbol: symbol, name: symbol, isFO: true };
      
      // Helper to close a trade on Reversal
      const closeTrade = async (tr, currentCandle, closeReason) => {
        const profitPct = (tr.direction === "BULLISH" || tr.direction === "CALL") 
            ? (currentCandle.close - tr.entryPrice) / tr.entryPrice
            : (tr.entryPrice - currentCandle.close) / tr.entryPrice;
        tr.status = "CLOSED";
        tr.closedAt = dt;
        tr.exitPrice = currentCandle.close;
        tr.pnlPct = profitPct * 100;
        if (closeReason) tr.reasons.push(closeReason);
        await tr.save();
        delete activeTrades[tr.scannerId];
      };

      // 1. Evaluate Options Scanners
      const optResult = evaluateOptionsOpportunity(stock, ind, liveData, marketOverview);
      if (optResult && optResult.triggered) {
        let direction = optResult.direction; // "BULLISH" or "BEARISH"
        let scannerId = direction === "BULLISH" ? "options-bullish" : "options-bearish";
        let oppScannerId = direction === "BULLISH" ? "options-bearish" : "options-bullish";

        if (activeTrades[oppScannerId]) {
          await closeTrade(activeTrades[oppScannerId], candle, "Reversal Signal");
        }

        if (!activeTrades[scannerId]) {
          const trade = new FoActiveTrade({
            symbol: symbol,
            direction: direction,
            scannerId: scannerId,
            entryPrice: candle.close,
            status: "ACTIVE",
            triggeredAt: dt,
            reasons: optResult.reasons,
            confidence: "High",
            strengthScore: optResult.strengthScore || 85
          });
          await trade.save();
          activeTrades[scannerId] = trade;
          totalSignals++;
        }
      }

      // 2. Evaluate Momentum Tracker Scanners
      const momResultArray = calculateMomentumTrackerV10(slice);
      const lastMom = momResultArray.length > 0 ? momResultArray[momResultArray.length - 1] : null;

      if (lastMom && (lastMom.signal === "LONG" || lastMom.signal === "SHORT")) {
        let direction = lastMom.signal === "LONG" ? "BULLISH" : "BEARISH";
        let scannerId = direction === "BULLISH" ? "fo-bullish" : "fo-bearish";
        let oppScannerId = direction === "BULLISH" ? "fo-bearish" : "fo-bullish";

        if (activeTrades[oppScannerId]) {
          await closeTrade(activeTrades[oppScannerId], candle, "Reversal Signal");
        }

        if (!activeTrades[scannerId]) {
          const trade = new FoActiveTrade({
            symbol: symbol,
            direction: direction,
            scannerId: scannerId,
            entryPrice: candle.close,
            status: "ACTIVE",
            triggeredAt: dt,
            reasons: ["Momentum Tracker V10 Signal", lastMom.isReversal ? "Trend Reversal Detected" : "Trend Continuation"],
            confidence: "Medium",
            strengthScore: 75
          });
          await trade.save();
          activeTrades[scannerId] = trade;
          totalSignals++;
        }
      }
    }
  }

  console.log(`Simulation complete! Generated ${totalSignals} trades over past 7 days.`);
  process.exit(0);
}

simulate();
