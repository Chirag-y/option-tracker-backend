const fs = require("fs");
const path = require("path");

const SCRIP_MASTER_LOCAL_PATH = path.join(__dirname, "../config/scripMaster.json");

if (!fs.existsSync(SCRIP_MASTER_LOCAL_PATH)) {
  console.log("scripMaster.json does not exist");
  process.exit(1);
}

console.log("Loading scripMaster...");
const data = JSON.parse(fs.readFileSync(SCRIP_MASTER_LOCAL_PATH, "utf-8"));
console.log("Total entries:", data.length);

const results = [];
for (const item of data) {
  const symbol = item.symbol || "";
  const name = item.name || "";
  if (symbol.includes("Nifty") || symbol.includes("NIFTY") || symbol.includes("SENSEX") || symbol.includes("Sensex")) {
    if (item.exch_seg === "NSE" || item.exch_seg === "BSE" || item.exch_seg === "NFO") {
      results.push({
        token: item.token,
        symbol: item.symbol,
        name: item.name,
        exch_seg: item.exch_seg,
        instrumenttype: item.instrumenttype
      });
    }
  }
}

console.log("Found matches count:", results.length);
// Print a few index-like matches
const indices = results.filter(r => !r.instrumenttype || r.instrumenttype === "" || r.instrumenttype === "AMXIDX");
console.log("Indices found:", indices.slice(0, 50));
