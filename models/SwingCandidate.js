const mongoose = require("mongoose");

/**
 * Persisted Swing Tracker signals. The LiveUniverseManager queries this collection
 * to include symbols that triggered in the last N (default 3) trading days
 * so they remain on the live websocket subscription list.
 *
 * One document per (symbol, scannerId, triggerDate) combination.
 */
const swingCandidateSchema = new mongoose.Schema(
  {
    symbol:       { type: String, required: true, index: true },
    name:         { type: String, default: "" },
    scannerId:    { type: String, default: "swing-tracker", index: true },
    direction:    { type: String, enum: ["BULLISH", "BEARISH"], default: "BULLISH" },
    triggerDate:  { type: Date,   required: true, index: true },   // start-of-day in IST
    triggerPrice: { type: Number, default: 0 },
    strengthScore:{ type: Number, default: 0 },
    isFO:         { type: Boolean, default: false },
    sector:       { type: String, default: "" },
    raw:          { type: mongoose.Schema.Types.Mixed }, // full original signal payload (audit)
  },
  { timestamps: true }
);

swingCandidateSchema.index({ symbol: 1, scannerId: 1, triggerDate: 1 }, { unique: true });
swingCandidateSchema.index({ triggerDate: -1 });

module.exports = mongoose.model("SwingCandidate", swingCandidateSchema);
