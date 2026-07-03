/**
 * Global queue for Angel SmartAPI getCandleData — all modules share one throttle.
 * Angel returns 403 when too many historical requests hit the account in parallel.
 */
const smartApiSession = require("./smartApiSession");

const MIN_GAP_MS = 4_000;
let lastCallAt = 0;
let chain = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getCandleDataQueued(params, { label = "candle" } = {}) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCallAt));
    if (wait > 0) await sleep(wait);

    if (!smartApiSession.getSmartApiInstance()) {
      await smartApiSession.initializeSession();
    }
    const api = smartApiSession.getSmartApiInstance();
    if (!api) throw new Error("SmartAPI not initialized");

    lastCallAt = Date.now();
    return api.getCandleData(params);
  });

  chain = run.catch(() => {});
  return run;
}

module.exports = { getCandleDataQueued, MIN_GAP_MS };
