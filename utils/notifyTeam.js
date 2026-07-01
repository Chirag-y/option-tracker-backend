const { sendPushToUsers } = require("./onesignal");

module.exports = async ({ recipientIds, trade, sender, notificationId }) => {
  try {
    return await sendPushToUsers({
      recipientIds,
      name: "trade-created",
      headings: { en: `New trade by ${sender}` },
      contents: {
        en: `${trade.instrument} ${trade.resultType} - Rs ${Math.abs(trade.finalAmount).toFixed(2)}`
      },
      data: {
        // Canonical mobile-side type — matches the in-app feed value so the RN
        // client's shouldSuppress() and dedup logic can key off a stable string.
        type: "TRADE_RESULT",
        notificationId: notificationId || null,
        tradeId: String(trade._id),
        teamCode: trade.teamCode
      }
    });
  } catch (err) {
    console.error("OneSignal notify failed:", err?.response?.data || err?.message || err);
    return null;
  }
};
