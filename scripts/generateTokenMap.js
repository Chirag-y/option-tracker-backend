const fs = require('fs');
console.log("Generating symbolToTokenMap...");
const scripData = JSON.parse(fs.readFileSync('backend/config/scripMaster.json', 'utf8'));
const map = {};
for (const item of scripData) {
  if (item.exch_seg === "NFO" && item.name === "NIFTY") {
    map[item.symbol] = {
      token: item.token,
      exch_seg: item.exch_seg,
      symbol: item.symbol,
      expiry: item.expiry
    };
  }
}
fs.writeFileSync('backend/config/symbolToTokenMap.json', JSON.stringify(map, null, 2));
console.log(`Generated map with ${Object.keys(map).length} NIFTY symbols.`);
