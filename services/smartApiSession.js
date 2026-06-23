const { generateSync } = require("otplib");
const { SmartAPI } = require("smartapi-javascript");

let sessionData = null;
let smartApiInstance = null;
let refreshInFlight = null;
const sessionRefreshListeners = new Set();

/**
 * Programmatically generates the 2FA TOTP token from the secret key.
 */
function generateTotp() {
  const secret = process.env.SMARTAPI_TOTP_SECRET;
  if (!secret) {
    throw new Error("SMARTAPI_TOTP_SECRET is missing in environment configuration.");
  }
  // Remove spaces or hyphens if any
  const cleanedSecret = secret.replace(/\s+/g, "").toUpperCase();
  return generateSync({ secret: cleanedSecret });
}

function attachSessionExpiryHook(api) {
  if (!api || typeof api.setSessionExpiryHook !== "function") return;

  api.setSessionExpiryHook(() => {
    refreshSession("session-expired").catch((error) => {
      console.error("[SmartAPI] Automatic session refresh failed:", error.message);
    });
  });
}

async function notifySessionRefreshListeners(session) {
  const listeners = Array.from(sessionRefreshListeners);
  for (const listener of listeners) {
    try {
      await listener(session);
    } catch (error) {
      console.error("[SmartAPI] Session refresh listener failed:", error.message);
    }
  }
}

/**
 * Establishes a new daily session with Angel One SmartAPI.
 */
async function initializeSession() {
  try {
    const apiKey = process.env.SMARTAPI_API_KEY;
    const clientCode = process.env.SMARTAPI_CLIENT_CODE;
    const password = process.env.SMARTAPI_PASSWORD;

    if (!apiKey || !clientCode || !password) {
      throw new Error("Missing required SmartAPI credentials in .env file.");
    }

    console.log(`[SmartAPI] Generating TOTP for Client: ${clientCode}...`);
    const totpToken = generateTotp();

    console.log("[SmartAPI] Initiating login request...");
    const api = new SmartAPI({
      api_key: apiKey,
    });
    attachSessionExpiryHook(api);

    const response = await api.generateSession(clientCode, password, totpToken);

    if (response && response.status === true && response.data) {
      sessionData = {
        jwtToken: response.data.jwtToken,
        refreshToken: response.data.refreshToken,
        feedToken: response.data.feedToken,
        clientCode: clientCode,
      };
      smartApiInstance = api;
      console.log("[SmartAPI] Session successfully initialized!");
      await notifySessionRefreshListeners(sessionData);
      return sessionData;
    } else {
      throw new Error(response.message || "Failed to generate session - Invalid response structure.");
    }
  } catch (error) {
    console.error("[SmartAPI] Session initialization failed:", error.message);
    throw error;
  }
}

/**
 * Returns the currently active authenticated session data.
 */
function getSession() {
  return sessionData;
}

/**
 * Returns the active SmartAPI client instance.
 */
function getSmartApiInstance() {
  if (!smartApiInstance) {
    throw new Error("SmartAPI session has not been initialized yet.");
  }
  return smartApiInstance;
}

/**
 * Manually registers an externally generated OAuth session.
 */
function setSessionManually(session) {
  sessionData = session;
  const { SmartAPI } = require("smartapi-javascript");
  smartApiInstance = new SmartAPI({
    api_key: process.env.SMARTAPI_API_KEY,
  });
  attachSessionExpiryHook(smartApiInstance);
}

async function refreshSession(reason = "manual") {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    console.log(`[SmartAPI] Refreshing session (${reason})...`);
    return initializeSession();
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function registerSessionRefreshListener(listener) {
  sessionRefreshListeners.add(listener);
  return () => {
    sessionRefreshListeners.delete(listener);
  };
}

module.exports = {
  initializeSession,
  refreshSession,
  getSession,
  getSmartApiInstance,
  setSessionManually,
  registerSessionRefreshListener
};
