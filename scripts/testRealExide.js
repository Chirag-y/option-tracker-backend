require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { evaluateOptionsOpportunity } = require('../services/optionsOpportunityScanner');
const { calculateMomentumTrackerV10 } = require('../services/momentumTracker');
const intradayCandleStore = require('../services/intradayCandleStore');
const scannerEngine = require('../services/scannerEngine');

async function testRealExide() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener");
  
  const dailyPath = path.join(__dirname, '../config/historicalDailyCandles.json');
  const dailyData = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
  
  const dailyCandles = dailyData["EXIDEIND"];
  if (!dailyCandles || dailyCandles.length === 0) {
    console.log("No daily candles for EXIDEIND");
    process.exit(1);
  }

  // Calculate real daily indicators!
  const ind = scannerEngine.getStockIndicators(dailyCandles);
  
  const fiveMinCandles = await intradayCandleStore.loadHistoricalIntradayCandles("EXIDEIND", "FIVE_MINUTE");
  if (!fiveMinCandles || fiveMinCandles.length === 0) {
    console.log("No EXIDEIND intraday candles found in Mongo!");
    process.exit(1);
  }

  console.log(`Evaluating ${fiveMinCandles.length} five-min candles for EXIDEIND using REAL daily indicators...`);
  console.log("Real Indicators Calculated:", { 
    currentEma20: ind.currentEma20, 
    currentEma50: ind.currentEma50, 
    currentEma200: ind.currentEma200, 
    currentRsi: ind.currentRsi 
  });

  // We need market overview.
  const marketOverviewBullish = { trendScore: 80, niftyChangePercent: 1.0 };
  const marketOverviewBearish = { trendScore: 20, niftyChangePercent: -1.0 };
  
  let tradesBullishOptions = [];
  let tradesBearishOptions = [];
  let tradesBullishFo = [];
  let tradesBearishFo = [];

  const dayHighLows = {};
  
  // Calculate momentum tracker signals for fo-bullish and fo-bearish
  const momentumResults = calculateMomentumTrackerV10(fiveMinCandles);

  for (let i = 0; i < fiveMinCandles.length; i++) {
    const candle = fiveMinCandles[i];
    const day = candle.date.split('T')[0];
    if (!dayHighLows[day]) {
      dayHighLows[day] = { high: candle.high, low: candle.low };
    } else {
      dayHighLows[day].high = Math.max(dayHighLows[day].high, candle.high);
      dayHighLows[day].low = Math.min(dayHighLows[day].low, candle.low);
    }
    
    const liveData = {
      price: candle.close,
      high: dayHighLows[day].high,
      low: dayHighLows[day].low,
      volume: candle.volume,
      changePercent: ((candle.close - ind.previousDayLow) / ind.previousDayLow) * 100
    };

    // Evaluate options scanners
    const bullResult = evaluateOptionsOpportunity({ symbol: "EXIDEIND", isFO: true }, ind, liveData, marketOverviewBullish);
    if (bullResult && bullResult.direction === "BULLISH") {
      tradesBullishOptions.push({ date: candle.date, price: candle.close, type: bullResult.direction, score: bullResult.strengthScore });
    }
    
    const bearResult = evaluateOptionsOpportunity({ symbol: "EXIDEIND", isFO: true }, ind, liveData, marketOverviewBearish);
    if (bearResult && bearResult.direction === "BEARISH") {
      tradesBearishOptions.push({ date: candle.date, price: candle.close, type: bearResult.direction, score: bearResult.strengthScore });
    }

    // Evaluate fo scanners (Momentum V10)
    if (momentumResults[i] && momentumResults[i].signal) {
        if (momentumResults[i].signal === "LONG") {
            tradesBullishFo.push({ date: candle.date, price: candle.close, type: "BULLISH", signal: "LONG" });
        } else if (momentumResults[i].signal === "SHORT") {
            tradesBearishFo.push({ date: candle.date, price: candle.close, type: "BEARISH", signal: "SHORT" });
        }
    }
  }

  console.log(`\nGenerated ${tradesBullishFo.length} BULLISH trades for EXIDEIND (fo-bullish)`);
  if (tradesBullishFo.length > 0) console.log(tradesBullishFo);

  console.log(`\nGenerated ${tradesBearishFo.length} BEARISH trades for EXIDEIND (fo-bearish)`);
  if (tradesBearishFo.length > 0) console.log(tradesBearishFo);

  console.log(`\nGenerated ${tradesBullishOptions.length} BULLISH trades for EXIDEIND (options-bullish)`);
  if (tradesBullishOptions.length > 0) console.log(tradesBullishOptions);

  console.log(`\nGenerated ${tradesBearishOptions.length} BEARISH trades for EXIDEIND (options-bearish)`);
  if (tradesBearishOptions.length > 0) console.log(tradesBearishOptions);

  process.exit(0);
}

testRealExide();
