const mongoose = require("mongoose");

const intradayCandleSchema = new mongoose.Schema(
  {
    symbol: {
      type: String,
      required: true,
      index: true,
    },
    interval: {
      type: String, // e.g., "ONE_MINUTE", "THREE_MINUTE", "FIVE_MINUTE"
      required: true,
    },
    date: {
      type: String, // ISO String or YYYY-MM-DDTHH:mm:ss
      required: true,
    },
    open: {
      type: Number,
      required: true,
    },
    high: {
      type: Number,
      required: true,
    },
    low: {
      type: Number,
      required: true,
    },
    close: {
      type: Number,
      required: true,
    },
    volume: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

// Compound index for fast retrieval of historical series per stock and interval
intradayCandleSchema.index({ symbol: 1, interval: 1, date: -1 }, { unique: true });

module.exports = mongoose.model("IntradayCandle", intradayCandleSchema);
