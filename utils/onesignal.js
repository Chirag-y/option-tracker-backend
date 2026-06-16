const axios = require("axios");

const ONESIGNAL_URL = "https://api.onesignal.com/notifications";

const unique = (values) =>
  [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];

const sendPushToUsers = async ({ recipientIds, name, headings, contents, data }) => {
  const targetIds = unique(recipientIds);
  if (
    !process.env.ONESIGNAL_APP_ID ||
    !process.env.ONESIGNAL_REST_API_KEY ||
    targetIds.length === 0
  ) {
    return null;
  }

  const response = await axios.post(
    ONESIGNAL_URL,
    {
      app_id: process.env.ONESIGNAL_APP_ID,
      target_channel: "push",
      include_aliases: {
        external_id: targetIds
      },
      name,
      headings,
      contents,
      data,
      content_available: true,
      android_background_data: true,
      mutable_content: true,
      ios_badgeType: "Increase",
      ios_badgeCount: 1
    },
    {
      headers: {
        Authorization: `Key ${process.env.ONESIGNAL_REST_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data;
};

module.exports = {
  sendPushToUsers
};
