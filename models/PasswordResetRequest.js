const mongoose = require("mongoose");

const PasswordResetRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    teamCode: { type: String, required: true, trim: true, uppercase: true },
    status: {
      type: String,
      enum: ["PENDING", "RESOLVED", "REJECTED"],
      default: "PENDING",
      index: true
    },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    adminNote: { type: String, default: "" }
  },
  { timestamps: true }
);

PasswordResetRequestSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model("PasswordResetRequest", PasswordResetRequestSchema);
