const mongoose = require("mongoose");

/**
 * EodScanState
 * ------------
 * Persists the "EOD swing scan already ran today" guard so we don't re-run
 * the full 1600+ NSE-EQ universe fetch on every server restart after 3:40 PM
 * IST. Keyed by the IST trading date string ("YYYY-MM-DD").
 *
 * One document per IST trading day. `completedAt` is set when the run finishes
 * (used to recover from mid-run crashes — a started-but-not-completed doc
 * simply means we should resume).
 */
const eodScanStateSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true }, // IST YYYY-MM-DD
    startedAt:       { type: Date, default: () => new Date() },
    completedAt:     { type: Date, default: null },
    symbolsFetched:  { type: Number, default: 0 },
    symbolsSkipped:  { type: Number, default: 0 },
    triggers:        { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EodScanState", eodScanStateSchema);
