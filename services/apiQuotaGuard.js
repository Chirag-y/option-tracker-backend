/**
 * Cross-module flags so Custom Options and Scanner don't fight for Angel API quota.
 */
let customOptionsHistoricalActive = false;
let scannerIntradayPreloadPaused = false;

function beginCustomOptionsHistoricalFetch() {
  customOptionsHistoricalActive = true;
  scannerIntradayPreloadPaused = true;
}

function endCustomOptionsHistoricalFetch() {
  customOptionsHistoricalActive = false;
  // Keep scanner preload paused briefly so custom-options retries can finish.
  setTimeout(() => {
    scannerIntradayPreloadPaused = false;
  }, 2 * 60 * 1000);
}

function isScannerIntradayPreloadPaused() {
  return scannerIntradayPreloadPaused || customOptionsHistoricalActive;
}

function isCustomOptionsHistoricalActive() {
  return customOptionsHistoricalActive;
}

module.exports = {
  beginCustomOptionsHistoricalFetch,
  endCustomOptionsHistoricalFetch,
  isScannerIntradayPreloadPaused,
  isCustomOptionsHistoricalActive,
};
