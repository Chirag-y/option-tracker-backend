const express = require("express");
const router = express.Router();
const scannerController = require("../controllers/scannerController");

// Index EHMA Signal Scanner
router.post("/hull-scan", scannerController.scanStock);

// Swing Tracker Scanner
router.post("/swing-tracker-scan", scannerController.scanSwingTracker);

// Commodities route
router.get("/commodities", scannerController.getCommodities);

// Backtesting endpoint
router.get("/:id/backtest", scannerController.getBacktest);

// Manual recalculation endpoint
router.post("/:id/recalculate", scannerController.recalculateScanner);

// Stock details endpoint
router.get("/stock/:symbol", scannerController.getStockDetails);

// F&O Active trades endpoint
router.get("/fo-active-trades", scannerController.getFoActiveTrades);

// Data status and fetching endpoints
router.get("/data-status", scannerController.getDataStatus);
router.post("/fetch-missing", scannerController.fetchMissingData);

module.exports = router;
