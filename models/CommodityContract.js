const mongoose = require("mongoose");

/**
 * Tracks the currently-active near-month MCX contract for each commodity.
 * Refreshed daily at 08:30 IST by CommodityContractManager from the Angel One Scrip Master.
 * Provides a stable source-of-truth so LiveUniverseManager can diff and roll over expiries
 * without re-parsing the entire scrip master on every cycle.
 */
const commodityContractSchema = new mongoose.Schema(
  {
    commodity: { type: String, required: true, index: true },  // CRUDEOIL, GOLD, ...
    symbol:    { type: String, required: true },               // e.g. CRUDEOIL20JUL2026FUT
    token:     { type: String, required: true },
    exchange:  { type: String, default: "MCX" },
    expiry:    { type: Date,   required: true },
    lotsize:   { type: Number, default: 1 },
    active:    { type: Boolean, default: true, index: true },
    updatedAt: { type: Date,   default: Date.now },
  },
  { timestamps: true }
);

commodityContractSchema.index({ commodity: 1, active: 1 });
commodityContractSchema.index({ symbol: 1 }, { unique: true });

module.exports = mongoose.model("CommodityContract", commodityContractSchema);
