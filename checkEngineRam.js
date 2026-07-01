const engine = require('./services/scannerEngine');

setTimeout(() => {
  const candles = engine.getHistoricalIntradayCandles();
  if (candles["RELIANCE"] && candles["RELIANCE"]["FIVE_MINUTE"]) {
    const rel = candles["RELIANCE"]["FIVE_MINUTE"];
    console.log("RELIANCE RAM last candle date:", rel[rel.length-1].date);
  } else {
    console.log("RELIANCE not in RAM");
  }
  process.exit(0);
}, 3000); // give it time to load from mongo on require
