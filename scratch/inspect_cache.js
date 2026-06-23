const fs = require("fs");
const path = require("path");

const cachePath = path.join(__dirname, "../config/historicalIntradayCandles.json");
if (!fs.existsSync(cachePath)) {
  console.log("No cached intraday candles found");
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
for (const sym of Object.keys(data)) {
  console.log(`\n=== ${sym} ===`);
  for (const interval of Object.keys(data[sym])) {
    const candles = data[sym][interval];
    console.log(`  ${interval}: ${candles.length} candles`);
    if (candles.length > 0) {
      console.log(`    First: date=${candles[0].date}, close=${candles[0].close.toFixed(2)}`);
      console.log(`    Last:  date=${candles[candles.length-1].date}, close=${candles[candles.length-1].close.toFixed(2)}`);
      
      // Check if it's real data (has IST offset) or mock (ISO UTC)
      const lastDate = candles[candles.length-1].date;
      const isReal = lastDate.includes("+05:30") || lastDate.includes("+0530");
      console.log(`    Data type: ${isReal ? "REAL API DATA" : "MOCK/UTC DATA"}`);
    }
  }
}
