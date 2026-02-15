const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  teamCode: { type: String, required: true, trim: true, index: true },
  isVerified: { type: Boolean, default: false, index: true },
  teamApprovalState: {
    type: String,
    enum: ["PENDING", "APPROVED", "REJECTED"],
    default: "PENDING",
    index: true
  },
  teamApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  teamApprovedAt: { type: Date, default: null },
  isTeamApproved: { type: Boolean, default: false, index: true },
  investedAmount: { type: Number, default: 0, min: 0 },
  sharePercentage: { type: Number, default: 0, min: 0, max: 100 },
  // FUTURE_ONLY: new member participates only from join onward.
  // FROM_START: member participates for full history after team approval/recalculation.
  pnlMode: { type: String, enum: ["FUTURE_ONLY", "FROM_START"], default: "FUTURE_ONLY" },
  pnlModeLocked: { type: Boolean, default: false },
  pnlEligibleFrom: { type: Date, default: Date.now },
  currentBalance: { type: Number, default: 0 }
}, { timestamps: true });

UserSchema.index({ email: 1, teamCode: 1 }, { unique: true });

module.exports = mongoose.model("User", UserSchema);
