const axios = require("axios");

const ONESIGNAL_URL = "https://onesignal.com/api/v1/notifications";

const buildPayload = ({ recipientIds, recipientPlayerIds, trade, sender }) => ({
  app_id: process.env.ONESIGNAL_APP_ID,
  include_external_user_ids: recipientIds,
  include_player_ids: recipientPlayerIds,
  headings: { en: `New trade by ${sender}` },
  contents: {
    en: `${trade.instrument} ${trade.resultType} · Rs ${Math.abs(trade.finalAmount).toFixed(2)}`
  },
  data: {
    tradeId: trade._id,
    teamCode: trade.teamCode
  },
  content_available: true,
  android_background_data: true,
  mutable_content: true,
  ios_badgeType: "Increase",
  ios_badgeCount: 1
});

module.exports = async ({ recipientIds, recipientPlayerIds, trade, sender }) => {
  const hasRecipients =
    (Array.isArray(recipientIds) && recipientIds.length > 0) ||
    (Array.isArray(recipientPlayerIds) && recipientPlayerIds.length > 0);
  if (
    !process.env.ONESIGNAL_APP_ID ||
    !process.env.ONESIGNAL_REST_API_KEY ||
    !hasRecipients
  ) {
    return;
  }

  try {
    await axios.post(
      ONESIGNAL_URL,
      buildPayload({ recipientIds, recipientPlayerIds, trade, sender }),
      {
        headers: {
          Authorization: `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (err) {
    console.error("OneSignal notify failed:", err?.message || err);
  }
};
