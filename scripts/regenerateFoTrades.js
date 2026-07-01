const mongoose = require('mongoose');
const { calculateMomentumTrackerV10 } = require('../services/momentumTracker');
const MONGO_URI = 'mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0';

async function generate() {
   await mongoose.connect(MONGO_URI);
   const FoActiveTrade = mongoose.model('FoActiveTrade', new mongoose.Schema({
       symbol: String, direction: String, scannerId: String, entryPrice: Number, 
       status: String, triggeredAt: Date, closedAt: Date, exitPrice: Number, 
       pnlPct: Number, strengthScore: Number
   }, {strict: false}));
   
   const IntradayCandle = mongoose.model('IntradayCandle', new mongoose.Schema({}, {strict: false}));
   const foStocks = require('../config/foUniverse');
   
   await FoActiveTrade.deleteMany({});
   
   let count = 0;
   const past7days = new Date();
   past7days.setDate(past7days.getDate() - 8);

   for (const stock of foStocks) {
      if (stock.symbol === 'NIFTY' || stock.symbol === 'BANKNIFTY') continue;
      const symbolKey = stock.symbol + '-EQ';
      const candles = await IntradayCandle.find({ symbol: symbolKey, interval: 'FIVE_MINUTE' }).sort({ date: 1 }).lean();
      if (!candles || candles.length < 50) {
         // fallback to normal symbol if EQ doesn't exist
         const altCandles = await IntradayCandle.find({ symbol: stock.symbol, interval: 'FIVE_MINUTE' }).sort({ date: 1 }).lean();
         if (!altCandles || altCandles.length < 50) continue;
         candles.push(...altCandles); // well just replace
         candles.splice(0, candles.length, ...altCandles);
      }
      
      const signals = calculateMomentumTrackerV10(candles);
      
      let activeTrade = null;
      for (const candle of candles) {
         const dateObj = new Date(candle.date);
         if (dateObj < past7days) continue;
         
         const istHours = dateObj.getUTCHours() + 5 + (dateObj.getUTCMinutes() + 30 >= 60 ? 1 : 0);
         const istMinutes = (dateObj.getUTCMinutes() + 30) % 60;
         
         const sig = signals.find(s => s.date === candle.date);
         if (sig && sig.signal === 'LONG' && !activeTrade) {
            if (istHours < 15 || (istHours === 15 && istMinutes <= 15)) {
               activeTrade = {
                  symbol: stock.symbol,
                  direction: 'BULLISH',
                  scannerId: 'fo-bullish',
                  entryPrice: candle.close,
                  status: 'ACTIVE',
                  triggeredAt: dateObj,
                  strengthScore: 70
               };
            }
         }
         
         if (activeTrade && (istHours > 15 || (istHours === 15 && istMinutes >= 25) || dateObj.getDate() !== activeTrade.triggeredAt.getDate())) {
             activeTrade.status = 'CLOSED';
             activeTrade.closedAt = dateObj; // EXACT EXIT DATE/TIME
             activeTrade.exitPrice = candle.close;
             activeTrade.pnlPct = ((candle.close - activeTrade.entryPrice) / activeTrade.entryPrice) * 100;
             await FoActiveTrade.create(activeTrade);
             count++;
             activeTrade = null;
         }
      }
      
      // If it's still active at the end (e.g. today before 3:30 PM), push it!
      if (activeTrade) {
         await FoActiveTrade.create(activeTrade);
         count++;
      }
   }
   console.log('Regenerated closed trades: ' + count);
   process.exit(0);
}
generate().catch(console.error);
