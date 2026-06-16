const { sendPushToUsers } = require("./onesignal");

module.exports = async ({ recipientIds, trade, sender }) => {
  try {
    return await sendPushToUsers({
      recipientIds,
      name: "trade-created",
      headings: { en: `New trade by ${sender}` },
      contents: {
        en: `${trade.instrument} ${trade.resultType} - Rs ${Math.abs(trade.finalAmount).toFixed(2)}`
      },
      data: {
        type: "trade_created",
        tradeId: String(trade._id),
        teamCode: trade.teamCode
      }
    });
  } catch (err) {
    console.error("OneSignal notify failed:", err?.response?.data || err?.message || err);
    return null;
  }
};
