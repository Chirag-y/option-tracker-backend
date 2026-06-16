const mongoose = require("mongoose");

const WebhookEventSchema = new mongoose.Schema({
  source: { type: String, default: "generic", trim: true, index: true },
  eventType: { type: String, default: "webhook.received", trim: true, index: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: null },
  headers: { type: mongoose.Schema.Types.Mixed, default: {} },
  receivedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

module.exports = mongoose.model("WebhookEvent", WebhookEventSchema);
