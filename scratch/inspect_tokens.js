const fs = require("fs");
const { loadScripMaster, symbolToTokenMap } = require("../services/marketDataFeed");

async function main() {
  await loadScripMaster();
  console.log("Keys containing Nifty:");
  const keys = Object.keys(symbolToTokenMap).filter(k => k.toLowerCase().includes("nifty"));
  console.log(keys.slice(0, 30));
  
  console.log("Nifty 50 mapped to:", symbolToTokenMap["Nifty 50"]);
  console.log("Nifty Bank mapped to:", symbolToTokenMap["Nifty Bank"]);
  console.log("SENSEX mapped to:", symbolToTokenMap["SENSEX"]);
}

main();
