const fs = require('fs');

const content = fs.readFileSync('backend/controllers/scannerController.js', 'utf8');

// The file currently has this around line 518:
//         date: new Date(arr[0]).toISOString(),
//  * Route: GET /api/scanner/commodities
//
// We need to restore lines 519-536 from before the mess, plus the missing fetchMissingData closure.

const target = `        date: new Date(arr[0]).toISOString(),
 * Route: GET /api/scanner/commodities`;

const replacement = `        date: new Date(arr[0]).toISOString(),
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
 * Route: GET /api/scanner/commodities`;

const newContent = content.replace(target, replacement);

fs.writeFileSync('backend/controllers/scannerController.js', newContent);
console.log("File patched successfully!");
