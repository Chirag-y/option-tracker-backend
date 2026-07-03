const fs = require('fs');
let code = fs.readFileSync('backend/controllers/scannerController.js', 'utf8');
const start = code.indexOf('const mapped = result.data.map(arr => ({');
const end = code.indexOf(' * (the authoritative source used by LiveUniverseManager + WebSocket feed).');

const replacement = `const mapped = result.data.map(arr => ({
        date: new Date(arr[0]).toISOString(),
        open: arr[1],
        high: arr[2],
        low: arr[3],
        close: arr[4],
        volume: arr[5]
      }));
      await intradayCandleStore.saveHistoricalIntradayCandles(symbol, interval, mapped);
      return res.json({ success: true, message: \`Saved \${mapped.length} candles to Mongo!\` });
    } else {
      return res.status(400).json({ success: true, message: "Missing data fetch initiated in background." });
    }
  } catch (err) {
    console.error("[ScannerController] fetchMissingData error:", err);
    return res.status(500).json({ success: false, message: "Server error during data fetch" });
  }
};

const { getCommodityUniverse, getTickCache } = require("../services/marketDataFeed");
const { getActiveCommodityUniverse } = require("../services/commodityContractManager");

/**
 * Endpoint to fetch live commodity prices from the MCX universe.
 * Route: GET /api/scanner/commodities
 *
 * Phase 0.2: prefer the Mongo-backed CommodityContractManager universe
`;

code = code.slice(0, start) + replacement + code.slice(end);
fs.writeFileSync('backend/controllers/scannerController.js', code);
console.log('Fixed');
