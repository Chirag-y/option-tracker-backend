const fs = require('fs');
const data = JSON.parse(fs.readFileSync('config/historicalIntradayCandles.json'));
const nifty = data['RELIANCE']['FIVE_MINUTE'];
console.log(nifty[nifty.length-1].date);
