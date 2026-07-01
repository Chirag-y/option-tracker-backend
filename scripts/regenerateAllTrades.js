const mongoose = require('mongoose');
const { calculateMomentumTrackerV10 } = require('../services/momentumTracker');
const { computeStockMetrics, calculateStrengthScore } = require('../services/scannerEngine');
const { evaluateOptionsOpportunity, getMarketTrend } = require('../services/optionsOpportunityScanner');
const MONGO_URI = 'mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0';

async function generate() {
   await mongoose.connect(MONGO_URI);
   const FoActiveTrade = mongoose.models.FoActiveTrade || mongoose.model('FoActiveTrade', new mongoose.Schema({
       symbol: String, direction: String, scannerId: String, entryPrice: Number, 
       status: String, triggeredAt: Date, closedAt: Date, exitPrice: Number, 
       pnlPct: Number, strengthScore: Number
   }, {strict: false}));
   
   const IntradayCandle = mongoose.models.IntradayCandle || mongoose.model('IntradayCandle', new mongoose.Schema({}, {strict: false}));
   
   const foStocks = require('../config/foUniverse');
   
   await FoActiveTrade.deleteMany({});
   console.log('Cleared existing trades');
   
   let count = 0;
   const past7days = new Date();
   past7days.setDate(past7days.getDate() - 8);

   async function processUniverse(stocks) {
       for (const stock of stocks) {
          if (stock.symbol === 'NIFTY' || stock.symbol === 'BANKNIFTY') continue;
          console.log(`Processing stock: ${stock.symbol}`);
          const symbolKey = stock.symbol + '-EQ';
          
          let candles = await IntradayCandle.find({ symbol: symbolKey, interval: 'FIVE_MINUTE' }).sort({ date: 1 }).lean();
          if (!candles || candles.length < 50) {
             const altCandles = await IntradayCandle.find({ symbol: stock.symbol, interval: 'FIVE_MINUTE' }).sort({ date: 1 }).lean();
             if (!altCandles || altCandles.length < 50) continue;
             candles = altCandles;
          }
          
          const signals = calculateMomentumTrackerV10(candles);
          
          let activeFoBullish = null;
          let activeFoBearish = null;
          let activeOptBullish = null;
          let activeOptBearish = null;
          
          for (const candle of candles) {
             const dateObj = new Date(candle.date);
             if (dateObj < past7days) continue;
             
             const istHours = dateObj.getUTCHours() + 5 + (dateObj.getUTCMinutes() + 30 >= 60 ? 1 : 0);
             const istMinutes = (dateObj.getUTCMinutes() + 30) % 60;
             const forceCloseTime = (istHours > 15 || (istHours === 15 && istMinutes >= 25));
             
             const sig = signals.find(s => s.date === candle.date);
             
             let currentStrengthScore = 70;
             let isTopQualityFo = false;

             // FO LOGIC
             if (sig && (sig.signal === 'LONG' || sig.signal === 'SHORT')) {
                 const currentCandleIndex = candles.findIndex(c => c.date === candle.date);
                 const trackerCandles = candles.slice(0, currentCandleIndex + 1);
                 const metrics = computeStockMetrics(stock.symbol, trackerCandles, []);
                 currentStrengthScore = metrics ? calculateStrengthScore(metrics, sig.signal === 'LONG' ? 'BULLISH' : 'BEARISH').score : 70;
                 if (currentStrengthScore > 75) {
                     isTopQualityFo = true;
                 }
             }

             // OPTIONS LOGIC
             let optResult = null;
             if (sig && (sig.signal === 'LONG' || sig.signal === 'SHORT')) {
                 const currentCandleIndex = candles.findIndex(c => c.date === candle.date);
                 const trackerCandles = candles.slice(0, currentCandleIndex + 1);
                 
                 // Compute simple indicators for options
                 const closes = trackerCandles.map(c => c.close);
                 const calcEma = (period) => {
                     let m = 2 / (period + 1), ema = closes[0];
                     for(let i = 1; i < closes.length; i++) ema = (closes[i] - ema) * m + ema;
                     return ema;
                 };
                 const rsiCalc = () => {
                     if (closes.length < 15) return 50;
                     let gains = 0, losses = 0;
                     for(let i = closes.length - 14; i < closes.length; i++) {
                         const diff = closes[i] - closes[i-1];
                         if (diff > 0) gains += diff; else losses -= diff;
                     }
                     const rs = (gains / 14) / (losses / 14 || 1);
                     return 100 - (100 / (1 + rs));
                 };

                 const ind = {
                     currentEma20: calcEma(20),
                     currentEma50: calcEma(50),
                     currentEma200: calcEma(200),
                     ema20Rising: (calcEma(20) > calcEma(20) * 0.999), // rough estimate
                     currentRsi: rsiCalc(),
                     avgVol20: trackerCandles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20,
                     pdh: Math.max(...trackerCandles.slice(-75).map(c=>c.high)),
                     previousDayLow: Math.min(...trackerCandles.slice(-75).map(c=>c.low)),
                     adx: 25,
                     vwap: candle.close
                 };
                 const liveData = { ltp: candle.close, volume: candle.volume, changePercent: 1.5, high: candle.high, low: candle.low };
                 const marketOverview = { niftyChangePercent: 0.5 };
                 
                 optResult = evaluateOptionsOpportunity(stock, ind, liveData, marketOverview);
             }

             // Handle FO Trades
             if (sig && sig.signal === 'LONG' && isTopQualityFo) {
                if (activeFoBearish) {
                   activeFoBearish.status = 'CLOSED'; activeFoBearish.closedAt = dateObj; activeFoBearish.exitPrice = candle.close;
                   activeFoBearish.pnlPct = ((activeFoBearish.entryPrice - candle.close) / activeFoBearish.entryPrice) * 100;
                   await FoActiveTrade.create(activeFoBearish); count++; activeFoBearish = null;
                }
                if (!activeFoBullish && (istHours < 14 || (istHours === 14 && istMinutes <= 55))) {
                   activeFoBullish = { symbol: stock.symbol, direction: 'BULLISH', scannerId: 'fo-bullish', entryPrice: candle.close, status: 'ACTIVE', triggeredAt: dateObj, strengthScore: currentStrengthScore };
                }
             }
             if (sig && sig.signal === 'SHORT' && isTopQualityFo) {
                if (activeFoBullish) {
                   activeFoBullish.status = 'CLOSED'; activeFoBullish.closedAt = dateObj; activeFoBullish.exitPrice = candle.close;
                   activeFoBullish.pnlPct = ((candle.close - activeFoBullish.entryPrice) / activeFoBullish.entryPrice) * 100;
                   await FoActiveTrade.create(activeFoBullish); count++; activeFoBullish = null;
                }
                if (!activeFoBearish && (istHours < 14 || (istHours === 14 && istMinutes <= 55))) {
                   activeFoBearish = { symbol: stock.symbol, direction: 'BEARISH', scannerId: 'fo-bearish', entryPrice: candle.close, status: 'ACTIVE', triggeredAt: dateObj, strengthScore: currentStrengthScore };
                }
             }

             // Handle Options Trades
             if (optResult && optResult.triggered && optResult.direction === 'BULLISH') {
                if (activeOptBearish) {
                   activeOptBearish.status = 'CLOSED'; activeOptBearish.closedAt = dateObj; activeOptBearish.exitPrice = candle.close;
                   activeOptBearish.pnlPct = ((activeOptBearish.entryPrice - candle.close) / activeOptBearish.entryPrice) * 100;
                   await FoActiveTrade.create(activeOptBearish); count++; activeOptBearish = null;
                }
                if (!activeOptBullish && (istHours < 14 || (istHours === 14 && istMinutes <= 55))) {
                   activeOptBullish = { symbol: stock.symbol, direction: 'BULLISH', scannerId: 'options-bullish', entryPrice: candle.close, status: 'ACTIVE', triggeredAt: dateObj, strengthScore: optResult.strengthScore };
                }
             }
             if (optResult && optResult.triggered && optResult.direction === 'BEARISH') {
                if (activeOptBullish) {
                   activeOptBullish.status = 'CLOSED'; activeOptBullish.closedAt = dateObj; activeOptBullish.exitPrice = candle.close;
                   activeOptBullish.pnlPct = ((candle.close - activeOptBullish.entryPrice) / activeOptBullish.entryPrice) * 100;
                   await FoActiveTrade.create(activeOptBullish); count++; activeOptBullish = null;
                }
                if (!activeOptBearish && (istHours < 14 || (istHours === 14 && istMinutes <= 55))) {
                   activeOptBearish = { symbol: stock.symbol, direction: 'BEARISH', scannerId: 'options-bearish', entryPrice: candle.close, status: 'ACTIVE', triggeredAt: dateObj, strengthScore: optResult.strengthScore };
                }
             }

             // Close Trades at EOD or Day Change
             if (activeFoBullish && (forceCloseTime || dateObj.getDate() !== activeFoBullish.triggeredAt.getDate())) {
                 activeFoBullish.status = 'CLOSED'; activeFoBullish.closedAt = dateObj; activeFoBullish.exitPrice = candle.close;
                 activeFoBullish.pnlPct = ((candle.close - activeFoBullish.entryPrice) / activeFoBullish.entryPrice) * 100;
                 await FoActiveTrade.create(activeFoBullish); count++; activeFoBullish = null;
             }
             if (activeFoBearish && (forceCloseTime || dateObj.getDate() !== activeFoBearish.triggeredAt.getDate())) {
                 activeFoBearish.status = 'CLOSED'; activeFoBearish.closedAt = dateObj; activeFoBearish.exitPrice = candle.close;
                 activeFoBearish.pnlPct = ((activeFoBearish.entryPrice - candle.close) / activeFoBearish.entryPrice) * 100;
                 await FoActiveTrade.create(activeFoBearish); count++; activeFoBearish = null;
             }
             if (activeOptBullish && (forceCloseTime || dateObj.getDate() !== activeOptBullish.triggeredAt.getDate())) {
                 activeOptBullish.status = 'CLOSED'; activeOptBullish.closedAt = dateObj; activeOptBullish.exitPrice = candle.close;
                 activeOptBullish.pnlPct = ((candle.close - activeOptBullish.entryPrice) / activeOptBullish.entryPrice) * 100;
                 await FoActiveTrade.create(activeOptBullish); count++; activeOptBullish = null;
             }
             if (activeOptBearish && (forceCloseTime || dateObj.getDate() !== activeOptBearish.triggeredAt.getDate())) {
                 activeOptBearish.status = 'CLOSED'; activeOptBearish.closedAt = dateObj; activeOptBearish.exitPrice = candle.close;
                 activeOptBearish.pnlPct = ((activeOptBearish.entryPrice - candle.close) / activeOptBearish.entryPrice) * 100;
                 await FoActiveTrade.create(activeOptBearish); count++; activeOptBearish = null;
             }
          }
       }
   }

   console.log('Processing FO universe...');
   await processUniverse(foStocks);
   
   console.log('Regenerated closed trades: ' + count);
   process.exit(0);
}
generate().catch(console.error);
