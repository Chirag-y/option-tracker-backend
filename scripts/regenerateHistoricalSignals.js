/**
 * Regenerate F&O + Swing signals from Mongo candle data (past 7 days).
 *
 *   node scripts/regenerateHistoricalSignals.js           # both
 *   node scripts/regenerateHistoricalSignals.js --fo-only  # skip swing (~2 min)
 *   node scripts/regenerateHistoricalSignals.js --swing-only
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const {
  regenerateSwingSignalsFromMongo,
  regenerateFoSignalsFromMongo,
} = require("../services/historicalSignalRegenerator");

async function main() {
  const args = process.argv.slice(2);
  const foOnly = args.includes("--fo-only");
  const swingOnly = args.includes("--swing-only");

  const t0 = Date.now();
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[RegenScript] Connected to MongoDB");

  const DailyCandle = require("../models/DailyCandle");
  const latest = await DailyCandle.findOne().sort({ date: -1 }).select("date symbol").lean();
  const count = await DailyCandle.countDocuments();
  console.log(`[RegenScript] DailyCandle docs=${count}, latest=${latest?.date} (${latest?.symbol})`);

  let swing = { totalSignals: 0, dashboardSignals: [] };
  let fo = { totalSignals: 0, dashboardSignals: {} };

  if (!foOnly) {
    console.log("[RegenScript] --- Swing (daily candles) ---");
    swing = await regenerateSwingSignalsFromMongo({ days: 7 });
  } else {
    console.log("[RegenScript] Skipping swing (--fo-only)");
  }

  if (!swingOnly) {
    console.log("[RegenScript] --- F&O (5-min intraday replay) ---");
    fo = await regenerateFoSignalsFromMongo({ days: 3 });
  } else {
    console.log("[RegenScript] Skipping F&O (--swing-only)");
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("[RegenScript] Complete in " + elapsed + "s:", {
    swingSignals: swing.totalSignals,
    swingDashboard: swing.dashboardSignals?.length ?? 0,
    foTrades: fo.totalSignals,
    foBullishDashboard: fo.dashboardSignals?.["fo-bullish"]?.length || 0,
    foBearishDashboard: fo.dashboardSignals?.["fo-bearish"]?.length || 0,
  });

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error("[RegenScript] Failed:", err);
  process.exit(1);
});
