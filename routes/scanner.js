const express = require("express");
const router = express.Router();
const scannerController = require("../controllers/scannerController");

// Index EHMA Signal Scanner
router.post("/hull-scan", scannerController.scanStock);

// Swing Tracker Scanner
router.post("/swing-tracker-scan", scannerController.scanSwingTracker);

// Backtesting endpoint
router.get("/:id/backtest", scannerController.getBacktest);

// Manual recalculation endpoint
router.post("/:id/recalculate", scannerController.recalculateScanner);

// Stock details endpoint
router.get("/stock/:symbol", scannerController.getStockDetails);

module.exports = router;
