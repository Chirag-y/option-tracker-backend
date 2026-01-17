const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  investedAmount: { type: Number, default: 0 },
  sharePercentage: { type: Number, default: 50 },
  currentBalance: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model("User", UserSchema);