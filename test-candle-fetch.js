require("dotenv").config();
const { initializeSession, getSmartApiInstance } = require("./services/smartApiSession");
const { loadScripMaster, symbolToTokenMap } = require("./services/marketDataFeed");

async function run() {
  try {
    console.log("Initializing session...");
    await initializeSession();
    
    console.log("Loading scrip master...");
    await loadScripMaster();

    const api = getSmartApiInstance();
    const symbolKey = "JINDALSTEL-EQ";
    const instrument = symbolToTokenMap[symbolKey];

    if (!instrument) {
      console.error(`Instrument not found for ${symbolKey}`);
      return;
    }

    console.log(`Found instrument for ${symbolKey}:`, instrument);

    // Fetch daily candles for the last 60 days
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 100);

    const formatOffsetDate = (date) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 09:15`;
    };

    const fromStr = formatOffsetDate(fromDate);
    const toStr = formatOffsetDate(toDate);

    console.log(`Fetching candles from ${fromStr} to ${toStr}...`);

    const response = await api.getCandleData({
      exchange: instrument.segment === "nse_cm" ? "NSE" : "NSE",
      symboltoken: instrument.token,
      interval: "ONE_DAY",
      fromdate: fromStr,
      todate: toStr
    });

    console.log("Response status:", response?.status);
    console.log("Response data count:", response?.data?.length);
    if (response?.data && response.data.length > 0) {
      console.log("First candle:", response.data[0]);
      console.log("Last 3 candles:", response.data.slice(-3));
    } else {
      console.log("Full response:", JSON.stringify(response, null, 2));
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

run();
