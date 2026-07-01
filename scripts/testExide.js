require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const { getSmartApiInstance, initializeSession } = require('../services/smartApiSession');
const intradayCandleStore = require('../services/intradayCandleStore');
const { symbolToTokenMap, loadScripMaster } = require('../services/marketDataFeed');

async function testExide() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener");
  console.log("Connected to Mongo.");

  await initializeSession();
  console.log("SmartAPI Session Initialized.");

  await loadScripMaster();
  const tokenMap = symbolToTokenMap;
  
  const symbolKey = "EXIDEIND-EQ";
  const instrument = tokenMap[symbolKey];
  if (!instrument) {
    console.log("Could not find token for EXIDEIND-EQ");
    process.exit(1);
  }

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(toDate.getDate() - 7);

  const formatOffsetDate = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const api = getSmartApiInstance();
  console.log("Fetching EXIDEIND 5-minute candles...");
  const response = await api.getCandleData({
    exchange: instrument.segment === "BSE" ? "BSE" : "NSE",
    symboltoken: instrument.token,
    interval: "FIVE_MINUTE",
    fromdate: formatOffsetDate(fromDate),
    todate: formatOffsetDate(toDate)
  });

  if (response && response.data && Array.isArray(response.data)) {
    const candles = response.data.map(r => ({
      date: r[0],
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: r[5]
    }));
    
    console.log(`Fetched ${candles.length} candles. Storing in Mongo...`);
    await intradayCandleStore.saveHistoricalIntradayCandles("EXIDEIND", "FIVE_MINUTE", candles);
    
    const loaded = await intradayCandleStore.loadHistoricalIntradayCandles("EXIDEIND", "FIVE_MINUTE");
    console.log(`Loaded ${loaded.length} candles from Mongo. First candle:`, loaded[0]);
    console.log(`Test passed! EXIDEIND is successfully saved and loaded.`);
  } else {
    console.log("Failed to fetch data:", response);
  }
  process.exit(0);
}

testExide();
