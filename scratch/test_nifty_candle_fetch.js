require("dotenv").config();
const { initializeSession, getSmartApiInstance } = require("../services/smartApiSession");
const { loadScripMaster, symbolToTokenMap } = require("../services/marketDataFeed");

async function main() {
  try {
    console.log("Initializing session...");
    await initializeSession();
    await loadScripMaster();

    const api = getSmartApiInstance();
    const token = "99926000"; // Nifty 50
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 7);

    const formatOffsetDate = (date) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 09:15`;
    };

    const fromStr = formatOffsetDate(fromDate);
    const toStr = formatOffsetDate(toDate);

    console.log(`Fetching Nifty 50 THREE_MINUTE candles from ${fromStr} to ${toStr}...`);

    const response = await api.getCandleData({
      exchange: "NSE",
      symboltoken: token,
      interval: "THREE_MINUTE",
      fromdate: fromStr,
      todate: toStr
    });

    console.log("Response status:", response?.status);
    console.log("Response message:", response?.message);
    console.log("Response data count:", response?.data?.length);
    if (response?.data && response.data.length > 0) {
      console.log("Last candle:", response.data[response.data.length - 1]);
    } else {
      console.log("Response JSON:", JSON.stringify(response));
    }
  } catch (err) {
    console.error("Error in fetching nifty candles:", err.message);
  }
}

main();
