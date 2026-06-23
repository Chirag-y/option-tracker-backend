const fs = require("fs");
const path = require("path");

const intradayCandlesCachePath = "D:\\MERN\\Option Tracker\\backend\\config\\historicalIntradayCandles.json";
const historicalIntradayCandles = JSON.parse(fs.readFileSync(intradayCandlesCachePath, "utf-8"));

const indexData = historicalIntradayCandles["Nifty 50"] || {};
let threeMin = indexData["THREE_MINUTE"] || [];

// Let's find all candles on 19 June afternoon
const june19Candles = threeMin.filter(c => c.date.includes("2026-06-19T15:"));
june19Candles.forEach(c => {
  console.log(`${c.date}: O:${c.open} H:${c.high} L:${c.low} C:${c.close}`);
});
