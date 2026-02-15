const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  teamCode: { type: String, required: true, trim: true, index: true },
  isVerified: { type: Boolean, default: false, index: true },
  investedAmount: { type: Number, default: 0, min: 0 },
  sharePercentage: { type: Number, default: 0, min: 0, max: 100 },
  currentBalance: { type: Number, default: 0 }
}, { timestamps: true });

UserSchema.index({ email: 1, teamCode: 1 }, { unique: true });

module.exports = mongoose.model("User", UserSchema);
