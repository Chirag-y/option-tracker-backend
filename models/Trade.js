const mongoose = require("mongoose");

const TradeSchema = new mongoose.Schema({
  teamCode: { type: String, required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  instrument: { type: String, required: true, trim: true },
  optionType: { type: String, enum: ["CALL", "PUT"], required: true },
  strikePrice: { type: Number, default: 0, min: 0 },
  resultType: { type: String, enum: ["PROFIT", "LOSS"], required: true },
  amount: { type: Number, required: true, min: 0 },
  charges: { type: Number, default: 0, min: 0 },
  finalAmount: { type: Number, required: true },
  tradeDate: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model("Trade", TradeSchema);
