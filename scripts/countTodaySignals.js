const mongoose = require("mongoose");
const FoActiveTrade = require("../models/FoActiveTrade");

async function checkTodaySignals() {
  await mongoose.connect("mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0");
  
  const trades = await FoActiveTrade.find({});
  let todayStr = "2026-06-30";
  
  const todayTrades = trades.filter(t => new Date(t.triggeredAt).toISOString().startsWith(todayStr));
  console.log(`Total trades: ${trades.length}`);
  console.log(`Today trades: ${todayTrades.length}`);
  
  let foBullish = todayTrades.filter(t => t.scannerId === 'fo-bullish').length;
  let foBearish = todayTrades.filter(t => t.scannerId === 'fo-bearish').length;
  let optBullish = todayTrades.filter(t => t.scannerId === 'options-bullish').length;
  let optBearish = todayTrades.filter(t => t.scannerId === 'options-bearish').length;
  console.log(`FO Bullish: ${foBullish}`);
  console.log(`FO Bearish: ${foBearish}`);
  console.log(`Options Bullish: ${optBullish}`);
  console.log(`Options Bearish: ${optBearish}`);
  
  mongoose.connection.close();
}

checkTodaySignals().catch(console.error);
