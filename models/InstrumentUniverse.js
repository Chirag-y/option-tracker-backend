const mongoose = require("mongoose");

/**
 * Authoritative F&O / equity universe synced daily from NSE / Angel One Scrip Master.
 * Replaces the manual config/foUniverse.js.
 *
 * One document per symbol. `active=false` rows are kept for audit but excluded from subscriptions.
 */
const instrumentUniverseSchema = new mongoose.Schema(
  {
    symbol:      { type: String, required: true, unique: true, index: true },
    name:        { type: String, default: "" },
    exchange:    { type: String, default: "NSE" },     // NSE / BSE
    segment:     { type: String, default: "NSE" },     // NSE / NFO / BSE / BFO / MCX
    isFO:        { type: Boolean, default: false, index: true },
    isEquity:    { type: Boolean, default: true },
    sector:      { type: String, default: "" },
    active:      { type: Boolean, default: true, index: true },
    lastUpdated: { type: Date,    default: Date.now },
  },
  { timestamps: true }
);

instrumentUniverseSchema.index({ isFO: 1, active: 1 });

module.exports = mongoose.model("InstrumentUniverse", instrumentUniverseSchema);
