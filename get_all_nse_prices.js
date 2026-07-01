require("dotenv").config();
const { initializeSession, getSmartApiInstance } = require("./services/smartApiSession");
const { loadScripMaster, symbolToTokenMap } = require("./services/marketDataFeed");
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    console.log("Initializing session...");
    await initializeSession();
    
    console.log("Loading scrip master...");
    await loadScripMaster();

    const api = getSmartApiInstance();
    const localPath = path.join(__dirname, "config/scripMaster.json");
    const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    
    const nseEq = data.filter(item => item.exch_seg === 'NSE' && item.symbol.endsWith('-EQ'));
    console.log(`Found ${nseEq.length} NSE-EQ instruments. Fetching prices in batches of 50...`);

    const batchSize = 50;
    const results = [];
    
    for (let i = 0; i < nseEq.length; i += batchSize) {
      const batch = nseEq.slice(i, i + batchSize);
      const tokens = batch.map(item => item.token);
      
      try {
        const response = await api.marketData({
          mode: "LTP",
          exchangeTokens: {
            "NSE": tokens
          }
        });
        
        if (response && response.status === true && response.data && response.data.fetched) {
          response.data.fetched.forEach(item => {
            const ltp = parseFloat(item.ltp);
            if (ltp > 75) {
              results.push({
                symbol: item.symbolName,
                token: item.symbolToken,
                ltp: ltp
              });
            }
          });
        }
      } catch (err) {
        console.error(`Batch ${i / batchSize} failed:`, err.message);
      }
      
      // Sleep 50ms
      await new Promise(resolve => setTimeout(resolve, 50));
      
      if (i > 0 && i % 500 === 0) {
        console.log(`Processed ${i} instruments. Mapped >75 price count: ${results.length}`);
      }
    }

    console.log(`\nFetch complete!`);
    console.log(`Total instruments with LTP > 75: ${results.length}`);
    console.log(`Sample results:`, results.slice(0, 10));

    // Save results to file for inspection
    fs.writeFileSync(path.join(__dirname, 'nse_above_75.json'), JSON.stringify(results, null, 2));
    
  } catch (err) {
    console.error("Error:", err.message);
  }
}

run();
