const mongoose = require("mongoose");

const CustomOptionsSignalSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  timeframe: { type: String, required: true, enum: ["1M", "3M"], index: true },
  date: { type: String, required: true }, // ISO string format
  timestamp: { type: Date, required: true, index: true },
  
  signal: { type: String, required: true, enum: ["BUY", "SELL", "ACTIVE", "EXIT", "SL_HIT", "CONFLUENCE_BREAK", "OPPOSITE_TRADE"] },
  ltp: { type: Number, required: true },
  
  // Indicator states at the time of signal
  ao: { type: Number },
  macdLine: { type: Number },
  macdSignal: { type: Number },
  rsi: { type: Number },
  sma18: { type: Number },
  sma18_prev: { type: Number },
  
  // Track if this is a live generated signal or historical fetch
  isHistorical: { type: Boolean, default: false },
  
  // Expiry date of the option contract (to enable automated cleanup)
  expiry: { type: Date, required: true, index: true }
}, { timestamps: true });

// Compound index to prevent duplicates
CustomOptionsSignalSchema.index({ symbol: 1, timeframe: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("CustomOptionsSignal", CustomOptionsSignalSchema);
