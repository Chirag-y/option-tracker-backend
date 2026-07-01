const fs = require('fs');
const { calculateMomentumTrackerV10 } = require('../services/momentumTracker');
const data = JSON.parse(fs.readFileSync('config/historicalIntradayCandles.json'));

let totalSignals = 0;
for (const [symbol, intervals] of Object.entries(data)) {
  const candles = intervals['FIVE_MINUTE'];
  if (!candles || candles.length < 50) continue;
  
  const signals = calculateMomentumTrackerV10(candles);
  const todaySignals = signals.filter(s => s.date.startsWith('2026-06-30') && s.signal === 'SHORT');
  if (todaySignals.length > 0) {
    console.log(`${symbol}: ${todaySignals.length} SHORT signals today`);
    totalSignals += todaySignals.length;
  }
}
console.log(`Total SHORT signals today: ${totalSignals}`);
