const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["TRADE_RESULT", "WEBHOOK_ALERT"],
      required: true,
      index: true
    },
    scope: {
      type: String,
      enum: ["GLOBAL", "TEAM", "USER"],
      required: true,
      index: true
    },
    teamCode: { type: String, default: null, trim: true, index: true },
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    source: { type: String, default: "system", trim: true, index: true },
    eventType: { type: String, default: "notification.created", trim: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    relatedTradeId: { type: mongoose.Schema.Types.ObjectId, ref: "Trade", default: null },
    relatedWebhookEventId: { type: mongoose.Schema.Types.ObjectId, ref: "WebhookEvent", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
  },
  { timestamps: true }
);

NotificationSchema.index({ createdAt: -1, type: 1, scope: 1, teamCode: 1 });

module.exports = mongoose.model("Notification", NotificationSchema);
