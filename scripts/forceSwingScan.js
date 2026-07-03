const { runEodSwingScan } = require("../services/scannerEngine");
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

async function main() {
  console.log("Connecting to Mongo...");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Running EOD Swing Scan...");
  await runEodSwingScan();
  console.log("Done!");
  process.exit(0);
}

main().catch(console.error);
