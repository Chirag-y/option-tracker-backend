const mongoose = require("mongoose");

const FoActiveTradeSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  direction: { type: String, enum: ["BULLISH", "BEARISH", "CALL", "PUT"], required: true },
  scannerId: { type: String, required: true, index: true }, // e.g. fo-bullish, options-bullish
  entryPrice: { type: Number, required: true },
  status: { type: String, enum: ["ACTIVE", "CLOSED"], default: "ACTIVE", index: true },
  triggeredAt: { type: Date, default: Date.now, index: true },
  closedAt: { type: Date },
  exitPrice: { type: Number },
  pnlPct: { type: Number },
  reasons: [{ type: String }],
  confidence: { type: String },
  strengthScore: { type: Number }
}, { timestamps: true });

module.exports = mongoose.model("FoActiveTrade", FoActiveTradeSchema);
