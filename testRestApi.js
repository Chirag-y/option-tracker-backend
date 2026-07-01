require('dotenv').config();
const { SmartAPI } = require('smartapi-javascript');
const api = new SmartAPI({ api_key: process.env.SMARTAPI_API_KEY });
api.generateSession(process.env.SMARTAPI_CLIENT_CODE, process.env.SMARTAPI_PASSWORD)
  .then(() => api.marketData({ mode: "FULL", exchangeTokens: { "NSE": ["26000", "26009", "26017"] } }))
  .then((response) => console.log(JSON.stringify(response.data, null, 2)))
  .catch(console.error);
