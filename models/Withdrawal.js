const mongoose = require("mongoose");

const WithdrawalSchema = new mongoose.Schema(
  {
    teamCode: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    withdrawalDate: { type: Date, required: true, default: Date.now },
    note: { type: String, default: "", trim: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Withdrawal", WithdrawalSchema);
