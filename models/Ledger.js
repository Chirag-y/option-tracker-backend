const mongoose = require("mongoose");

const LedgerSchema = new mongoose.Schema({
  teamCode: { type: String, required: true, index: true },
  tradeId: { type: mongoose.Schema.Types.ObjectId, ref: "Trade", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  amountChange: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Ledger", LedgerSchema);
