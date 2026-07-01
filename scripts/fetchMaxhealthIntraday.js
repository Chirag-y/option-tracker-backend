require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const { initializeSession, getSmartApiInstance } = require('../services/smartApiSession');
const intradayCandleStore = require('../services/intradayCandleStore');
const fs = require('fs');
const path = require('path');

async function fetchMaxhealth() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener");
  
  const fnoUniversePath = path.join(__dirname, '../config/scripMaster.json');
  const fnoData = JSON.parse(fs.readFileSync(fnoUniversePath, 'utf8'));
  const instrument = fnoData.find(s => s.name === "MAXHEALTH" && (s.instrumenttype === "OPTSTK" || s.instrumenttype === "FUTSTK" || s.exch_seg === "NSE"));
  
  if (!instrument) {
    console.error("MAXHEALTH not found in scripMaster!");
    process.exit(1);
  }

  await initializeSession();
  const api = getSmartApiInstance();
  
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(toDate.getDate() - 7);
  
  const formatAngelDate = (date, isEnd) => {
    return date.getFullYear() + "-" +
      String(date.getMonth() + 1).padStart(2, "0") + "-" +
      String(date.getDate()).padStart(2, "0") + (isEnd ? " 15:30" : " 09:15");
  };

  const reqBody = {
    exchange: "NSE",
    symboltoken: "22377", // Hardcoded MAXHEALTH token
    interval: "FIVE_MINUTE",
    fromdate: formatAngelDate(fromDate, false),
    todate: formatAngelDate(toDate, true)
  };

  try {
    console.log("Fetching...", reqBody);
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
      await intradayCandleStore.saveHistoricalIntradayCandles("MAXHEALTH", "FIVE_MINUTE", mapped);
      console.log(`Saved ${mapped.length} candles to Mongo!`);
    } else {
      console.log("No data returned:", result);
    }
  } catch (err) {
    console.error("Failed:", err.message);
  }
  
  process.exit(0);
}

fetchMaxhealth();
