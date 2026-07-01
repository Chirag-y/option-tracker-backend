const fs = require('fs');
const newFunc = `
function calculateStrengthScore(stock, direction = "BULLISH") {
    let trend = 0; let momentum = 0; let volume = 0; let relativeStrength = 0; let breakout = 0; let bonus = 0;
    if (direction === "BULLISH") {
      if (stock.ema20 > stock.ema50 && stock.ema50 > stock.ema200) trend += 10;
      else if (stock.ema20 > stock.ema50) trend += 5;
      const distanceFromEMA50 = ((stock.close - stock.ema50) / stock.ema50) * 100;
      if (distanceFromEMA50 > 10) trend += 10; else if (distanceFromEMA50 > 5) trend += 7; else if (distanceFromEMA50 > 2) trend += 5; else if (distanceFromEMA50 > 0) trend += 2;
      if (stock.weeklyClose > stock.weeklyEma20) trend += 5;
      if (stock.weeklyEma20 > stock.weeklyEma50) trend += 5;
    } else {
      if (stock.ema20 < stock.ema50 && stock.ema50 < stock.ema200) trend += 10;
      else if (stock.ema20 < stock.ema50) trend += 5;
      const distanceFromEMA50 = ((stock.ema50 - stock.close) / stock.ema50) * 100;
      if (distanceFromEMA50 > 10) trend += 10; else if (distanceFromEMA50 > 5) trend += 7; else if (distanceFromEMA50 > 2) trend += 5; else if (distanceFromEMA50 > 0) trend += 2;
      if (stock.weeklyClose < stock.weeklyEma20) trend += 5;
      if (stock.weeklyEma20 < stock.weeklyEma50) trend += 5;
    }
    if (direction === "BULLISH") {
      if (stock.rsi >= 65 && stock.rsi <= 80) momentum += 10; else if (stock.rsi >= 60) momentum += 7; else if (stock.rsi >= 55) momentum += 5;
      if (stock.rsi > stock.prevRsi) momentum += 5;
      if (stock.macdHistogram > 0) momentum += 5;
      if (stock.macdHistogram > stock.prevMacdHistogram) momentum += 5;
    } else {
      if (stock.rsi <= 35 && stock.rsi >= 20) momentum += 10; else if (stock.rsi <= 40) momentum += 7; else if (stock.rsi <= 45) momentum += 5;
      if (stock.rsi < stock.prevRsi) momentum += 5;
      if (stock.macdHistogram < 0) momentum += 5;
      if (stock.macdHistogram < stock.prevMacdHistogram) momentum += 5;
    }
    const relativeVolume = stock.volume / stock.avgVolume20;
    if (relativeVolume > 2) volume += 10; else if (relativeVolume > 1.5) volume += 7; else if (relativeVolume > 1.2) volume += 5;
    if (stock.deliveryPercent > 60) volume += 5; else if (stock.deliveryPercent > 50) volume += 3;
    if (stock.volume > stock.highestVolume10) volume += 5;
    const rs = stock.stockReturn20D - stock.niftyReturn20D;
    if (direction === "BULLISH") {
      if (rs > 15) relativeStrength += 10; else if (rs > 10) relativeStrength += 8; else if (rs > 5) relativeStrength += 5;
      if (stock.distanceFrom52WeekHigh <= 5) relativeStrength += 5;
    } else {
      if (rs < -15) relativeStrength += 10; else if (rs < -10) relativeStrength += 8; else if (rs < -5) relativeStrength += 5;
      if (stock.distanceFrom52WeekLow <= 5) relativeStrength += 5;
    }
    if (stock.breakout20Day || stock.breakout50Day || stock.breakoutSwingHigh) breakout += 5;
    const candleRange = stock.high - stock.low;
    let bodyPercent = 0;
    if (candleRange > 0) {
      bodyPercent = (Math.abs(stock.close - stock.open) / candleRange) * 100;
      if (bodyPercent > 70) breakout += 5; else if (bodyPercent > 50) breakout += 3;
    }
    if ((stock.adx ?? 0) > 25) bonus += 5;
    if (direction === "BULLISH" && (stock.mfi ?? 0) > 60) bonus += 5;
    if (direction === "BEARISH" && (stock.mfi ?? 0) < 40) bonus += 5;
    if (direction === "BULLISH" && (stock.weeklyRsi ?? 0) > 60) bonus += 5;
    if (direction === "BEARISH" && (stock.weeklyRsi ?? 0) < 40) bonus += 5;
    if (direction === "BULLISH" && stock.sectorOutperforming) bonus += 5;
    if (direction === "BEARISH" && !stock.sectorOutperforming) bonus += 5;
    let score = trend + momentum + volume + relativeStrength + breakout + bonus;
    if (bodyPercent < 20) score -= 10;
    if (direction === "BULLISH" && stock.rsi > 85) score -= 5;
    if (direction === "BEARISH" && stock.rsi < 15) score -= 5;
    if (direction === "BULLISH" && stock.close < stock.prevLow) score -= 10;
    if (direction === "BEARISH" && stock.close > stock.prevHigh) score -= 10;
    if (direction === "BULLISH" && stock.open > stock.prevClose * 1.08) score -= 5;
    if (direction === "BEARISH" && stock.open < stock.prevClose * 0.92) score -= 5;
    if (stock.volume < stock.avgVolume20) score -= 5;
    return { score, breakdown: { trend, momentum, volume, relativeStrength, breakout, bonus } };
}
`;
let content = fs.readFileSync('services/scannerEngine.js', 'utf8');
const startIdx = content.indexOf('function calculateStrengthScore(stock) {');
const endIdx = content.indexOf('module.exports = {');
content = content.substring(0, startIdx) + newFunc + '\n' + content.substring(endIdx);

// Also replace calculateStrengthScore calls based on scannerId
content = content.replace(/const strengthResult = calculateStrengthScore\(metrics\);/g, (match, offset) => {
    // Find the enclosing case statement to know the scannerId
    const textBefore = content.substring(0, offset);
    if (textBefore.includes('case "fo-bearish":') && offset - textBefore.lastIndexOf('case "fo-bearish":') < 1000) {
        return 'const strengthResult = calculateStrengthScore(metrics, "BEARISH");';
    }
    if (textBefore.includes('case "intraday-bearish":') && offset - textBefore.lastIndexOf('case "intraday-bearish":') < 1000) {
        return 'const strengthResult = calculateStrengthScore(metrics, "BEARISH");';
    }
    return 'const strengthResult = calculateStrengthScore(metrics, "BULLISH");';
});

// Update the other call for nifty
content = content.replace(/calculateStrengthScore\(metrics\)/g, 'calculateStrengthScore(metrics, "BULLISH")');

fs.writeFileSync('services/scannerEngine.js', content);
console.log('Successfully updated scannerEngine.js');
