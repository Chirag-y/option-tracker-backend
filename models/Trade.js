const mongoose = require("mongoose");

const TradeSchema = new mongoose.Schema({
  instrument: String,
  optionType: String,
  strikePrice: Number,
  resultType: String,
  amount: Number,
  charges: Number,
  finalAmount: Number,
  tradeDate: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model("Trade", TradeSchema);