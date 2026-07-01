require("dotenv").config();
const { initializeSession, getSmartApiInstance } = require("./services/smartApiSession");
const { loadScripMaster, symbolToTokenMap } = require("./services/marketDataFeed");
const { calculateSwingTracker } = require("./services/swingTracker");

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

    // Fetch daily candles for the last 150 days
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 150);

    const formatOffsetDate = (date) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 09:15`;
    };

    const fromStr = formatOffsetDate(fromDate);
    const toStr = formatOffsetDate(toDate);

    console.log(`Fetching candles from ${fromStr} to ${toStr}...`);

    const response = await api.getCandleData({
      exchange: "NSE",
      symboltoken: instrument.token,
      interval: "ONE_DAY",
      fromdate: fromStr,
      todate: toStr
    });

    if (response?.data && response.data.length > 0) {
      const formattedCandles = response.data.map(c => ({
        date: c[0].split("T")[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseInt(c[5])
      }));

      console.log(`Loaded ${formattedCandles.length} daily candles.`);

      // Run swing tracker calculations
      const trackerRes = calculateSwingTracker(formattedCandles, {
        sensitivity: 2.8,
        keltnerLength: 10,
        atrPeriod: 10,
        factor: 3.5
      });

      console.log("Swing Tracker Summary:", trackerRes.summary);
      console.log("Current Position (last state):", trackerRes.currentPos === 1 ? "LONG" : (trackerRes.currentPos === -1 ? "SHORT" : "NONE"));
      console.log("Recent Signals:", trackerRes.signals.slice(-5));
    } else {
      console.log("No data returned:", response);
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

run();
