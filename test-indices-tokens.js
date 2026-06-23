const { loadScripMaster, symbolToTokenMap } = require("./services/marketDataFeed");

async function run() {
  await loadScripMaster();
  const keys = ["Nifty 50", "Nifty Bank", "SENSEX", "RELIANCE-EQ", "JINDALSTEL-EQ"];
  for (const k of keys) {
    console.log(`${k}:`, symbolToTokenMap[k]);
  }
}

run();
