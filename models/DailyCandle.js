const mongoose = require("mongoose");

const dailyCandleSchema = new mongoose.Schema(
  {
    symbol: {
      type: String,
      required: true,
      index: true,
    },
    date: {
      type: String, // YYYY-MM-DD
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

// Compound index for fast retrieval of historical series per stock
dailyCandleSchema.index({ symbol: 1, date: -1 }, { unique: true });

module.exports = mongoose.model("DailyCandle", dailyCandleSchema);
