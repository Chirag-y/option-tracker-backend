const mongoose = require("mongoose");
const FoActiveTrade = require("../models/FoActiveTrade");
require("dotenv").config({ path: __dirname + "/../.env" });

async function runEodClosure() {
  try {
    await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener", {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("[EOD FoTrades] Connected to Mongo.");

    const result = await FoActiveTrade.updateMany(
      { status: "ACTIVE" },
      { $set: { status: "CLOSED", closedAt: new Date() } }
    );

    console.log(`[EOD FoTrades] Successfully closed ${result.modifiedCount} active trades.`);
    process.exit(0);
  } catch (error) {
    console.error("[EOD FoTrades] Error:", error);
    process.exit(1);
  }
}

runEodClosure();
