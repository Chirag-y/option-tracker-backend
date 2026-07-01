const mongoose = require("mongoose");
const FoActiveTrade = require("../models/FoActiveTrade");
require("dotenv").config();

async function cleanAndFetch() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // Delete all existing FO/Options trades to clear the bogus backtest duplicates
  await FoActiveTrade.deleteMany({});
  console.log("Cleared all existing historical trades from DB to reset identical scanners.");

  mongoose.connection.close();
}

cleanAndFetch().catch(console.error);
