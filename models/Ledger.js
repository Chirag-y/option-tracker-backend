const mongoose = require("mongoose");

const LedgerSchema = new mongoose.Schema({
  tradeId: mongoose.Schema.Types.ObjectId,
  userId: mongoose.Schema.Types.ObjectId,
  amountChange: Number,
  balanceAfter: Number,
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Ledger", LedgerSchema);