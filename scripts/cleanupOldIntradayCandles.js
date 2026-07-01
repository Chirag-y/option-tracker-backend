const mongoose = require("mongoose");
const IntradayCandle = require("../models/IntradayCandle");
require("dotenv").config({ path: __dirname + "/../.env" });

async function cleanupOldIntradayCandles() {
  try {
    await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener", {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("[Cleanup] Connected to Mongo.");

    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
    const thresholdDate = eightDaysAgo.toISOString();

    const result = await IntradayCandle.deleteMany({
      date: { $lt: thresholdDate }
    });

    console.log(`[Cleanup] Successfully deleted ${result.deletedCount} old IntradayCandles (older than 8 days).`);
    process.exit(0);
  } catch (error) {
    console.error("[Cleanup] Error:", error);
    process.exit(1);
  }
}

cleanupOldIntradayCandles();
