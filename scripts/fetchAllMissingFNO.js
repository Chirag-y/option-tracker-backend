require("dotenv").config({ path: __dirname + "/../.env" });
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { initializeSession } = require("../services/smartApiSession");
const { getSmartApiInstance } = require("../services/smartApiSession");
const intradayCandleStore = require("../services/intradayCandleStore");

const delay = ms => new Promise(res => setTimeout(res, ms));

async function fetchMissingDataForInterval(symbol, token, interval, days) {
  const api = getSmartApiInstance();
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(toDate.getDate() - days);

  const formatAngelDate = (date, isEnd) => {
    return date.getFullYear() + "-" +
      String(date.getMonth() + 1).padStart(2, "0") + "-" +
      String(date.getDate()).padStart(2, "0") + (isEnd ? " 15:30" : " 09:15");
  };

  const reqBody = {
    exchange: "NSE",
    symboltoken: token,
    interval: interval,
    fromdate: formatAngelDate(fromDate, false),
    todate: formatAngelDate(toDate, true)
  };

  try {
    const result = await api.getCandleData(reqBody);
    if (result && result.status && result.data && result.data.length > 0) {
      const mapped = result.data.map(arr => ({
        date: new Date(arr[0]).toISOString(),
        open: arr[1],
        high: arr[2],
        low: arr[3],
        close: arr[4],
        volume: arr[5]
      }));
      await intradayCandleStore.saveHistoricalIntradayCandles(symbol, interval, mapped);
      console.log(`Saved ${mapped.length} candles for ${symbol} (${interval})`);
    } else {
      console.log(`No data for ${symbol} (${interval}) - ${result?.message || 'Empty'}`);
    }
  } catch (err) {
    console.error(`Error fetching ${symbol} (${interval}):`, err.message);
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const success = await initializeSession();
  if (!success) {
    console.error("Failed to login to Angel One");
    process.exit(1);
  }
  
  const fnoUniversePath = path.join(__dirname, '../config/scripMaster.json');
  const fnoData = JSON.parse(fs.readFileSync(fnoUniversePath, 'utf8'));
  
  // Filter for F&O symbols only
  let fnoStocks = fnoData.filter(s => s.instrumenttype === "OPTSTK" || s.instrumenttype === "FUTSTK");
  // Get unique names
  const uniqueNames = [...new Set(fnoStocks.map(s => s.name))];
  
  // Also include indices
  uniqueNames.push("Nifty 50");
  uniqueNames.push("Nifty Bank");
  uniqueNames.push("Nifty Fin Service");
  uniqueNames.push("NIFTY MIDCAP 50");

  for (const name of uniqueNames) {
    let instrument;
    if (name.startsWith("Nifty") || name.startsWith("NIFTY")) {
      instrument = fnoData.find(s => s.name === name && (s.exch_seg === "NSE" || s.exch_seg === "NFO"));
    } else {
      instrument = fnoData.find(s => s.name === name && s.exch_seg === "NSE");
    }

    if (!instrument) {
       console.log("Skipping", name, "no token");
       continue;
    }

    console.log(`\nFetching ${name} (${instrument.token})...`);
    // 5 Minute
    await fetchMissingDataForInterval(name, instrument.token, "FIVE_MINUTE", 7);
    await delay(300);
    
    // 3 Minute
    await fetchMissingDataForInterval(name, instrument.token, "THREE_MINUTE", 7);
    await delay(300);
    
    // 1 Minute
    await fetchMissingDataForInterval(name, instrument.token, "ONE_MINUTE", 5);
    await delay(300);
  }
  
  console.log("Done fetching all F&O stocks.");
  process.exit(0);
}

run();
