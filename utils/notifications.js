const Notification = require("../models/Notification");

const splitCsv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const buildTradeNotificationText = (trade, senderName) => {
  const title = `Trade result added by ${senderName || "team member"}`;
  const amount = Number(trade.amount || 0).toFixed(2);
  const charges = Number(trade.charges || 0).toFixed(2);
  const finalAmount = Number(trade.finalAmount || 0).toFixed(2);
  const message = [
    trade.instrument,
    trade.optionType,
    trade.resultType,
    `Amount Rs ${amount}`,
    `Charges Rs ${charges}`,
    `Net Rs ${finalAmount}`
  ].join(" - ");

  return {
    title,
    message,
    metadata: {
      instrument: trade.instrument,
      optionType: trade.optionType,
      strikePrice: Number(trade.strikePrice || 0),
      resultType: trade.resultType,
      amount: Number(trade.amount || 0),
      charges: Number(trade.charges || 0),
      finalAmount: Number(trade.finalAmount || 0),
      tradeDate: trade.tradeDate,
      senderName
    }
  };
};

const formatChartinkAlert = (payload) => {
  if (!payload.stocks && !payload.scan_name && !payload.alert_name) {
    return null;
  }

  const stocks = splitCsv(payload.stocks);
  const prices = splitCsv(payload.trigger_prices);
  const pairs = stocks.map((stock, index) => {
    const price = prices[index];
    return price ? `${stock} @ ${price}` : stock;
  });

  const title = String(payload.alert_name || payload.scan_name || "Chartink alert").trim();
  const messageParts = [];
  if (pairs.length) {
    messageParts.push(pairs.slice(0, 8).join(", "));
  }
  if (stocks.length > 8) {
    messageParts.push(`+${stocks.length - 8} more`);
  }
  if (payload.triggered_at) {
    messageParts.push(`at ${payload.triggered_at}`);
  }

  return {
    title,
    message: messageParts.join(" ") || "Chartink alert triggered"
  };
};

const buildWebhookNotificationText = (payload, source) => {
  const chartinkAlert = formatChartinkAlert(payload);
  if (chartinkAlert) {
    return {
      ...chartinkAlert,
      metadata: {
        stocks: splitCsv(payload.stocks),
        triggerPrices: splitCsv(payload.trigger_prices),
        triggeredAt: payload.triggered_at || null,
        scanName: payload.scan_name || null,
        alertName: payload.alert_name || null
      }
    };
  }

  const title = String(payload.title || payload.heading || `${source} alert`).trim();
  const message = String(
    payload.message ||
      payload.content ||
      payload.alert ||
      payload.text ||
      payload.raw ||
      "New webhook alert received"
  ).trim();

  return {
    title: title || "Webhook alert",
    message: message || "New webhook alert received",
    metadata: {
      source,
      symbol: payload.symbol || payload.stock || payload.scrip || null,
      timeframe: payload.timeframe || payload.interval || null,
      action: payload.action || payload.signal || payload.side || null
    }
  };
};

const createNotification = async (input) => {
  return Notification.create(input);
};

module.exports = {
  buildTradeNotificationText,
  buildWebhookNotificationText,
  createNotification
};
