/**
 * Runtime feature flags for Railway / low-RAM deployments.
 *
 * SCANNER_MODE presets:
 *   full         — everything (default)
 *   lite         — mobile API + custom options only (no EOD, no FO, no WS universe)
 *   lite-fo      — lite + live FO scanners (fo-bullish / fo-bearish)
 *   api-only     — REST API only (auth, trades, team P/L) — no scanners
 *
 * Granular env vars override preset defaults when set explicitly.
 */

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

const SCANNER_MODE = String(process.env.SCANNER_MODE || process.env.RUN_PROFILE || "full")
  .trim()
  .toLowerCase();

const PRESETS = {
  full: {
    disableEodSwingScan: false,
    enableScannerEngine: true,
    enableCustomOptionsScanner: true,
    enableFoScanner: true,
    enableSwingScanner: true,
    enableIndexScanners: true,
    enableCommodityScanner: true,
    enableLiveWebSocket: true,
    enableBackgroundPreload: true
  },
  lite: {
    disableEodSwingScan: true,
    enableScannerEngine: false,
    enableCustomOptionsScanner: true,
    enableFoScanner: false,
    enableSwingScanner: false,
    enableIndexScanners: false,
    enableCommodityScanner: false,
    enableLiveWebSocket: false,
    enableBackgroundPreload: false
  },
  "lite-fo": {
    disableEodSwingScan: true,
    enableScannerEngine: true,
    enableCustomOptionsScanner: true,
    enableFoScanner: true,
    enableSwingScanner: false,
    enableIndexScanners: false,
    enableCommodityScanner: false,
    enableLiveWebSocket: true,
    enableBackgroundPreload: false
  },
  "api-only": {
    disableEodSwingScan: true,
    enableScannerEngine: false,
    enableCustomOptionsScanner: false,
    enableFoScanner: false,
    enableSwingScanner: false,
    enableIndexScanners: false,
    enableCommodityScanner: false,
    enableLiveWebSocket: false,
    enableBackgroundPreload: false
  }
};

const preset = PRESETS[SCANNER_MODE] || PRESETS.full;

const flags = {
  scannerMode: PRESETS[SCANNER_MODE] ? SCANNER_MODE : "full",
  disableEodSwingScan: parseBool(process.env.DISABLE_EOD_SWING_SCAN, preset.disableEodSwingScan),
  enableScannerEngine: parseBool(process.env.ENABLE_SCANNER_ENGINE, preset.enableScannerEngine),
  enableCustomOptionsScanner: parseBool(
    process.env.ENABLE_CUSTOM_OPTIONS_SCANNER,
    preset.enableCustomOptionsScanner
  ),
  enableFoScanner: parseBool(process.env.ENABLE_FO_SCANNER, preset.enableFoScanner),
  enableSwingScanner: parseBool(process.env.ENABLE_SWING_SCANNER, preset.enableSwingScanner),
  enableIndexScanners: parseBool(process.env.ENABLE_INDEX_SCANNERS, preset.enableIndexScanners),
  enableCommodityScanner: parseBool(
    process.env.ENABLE_COMMODITY_SCANNER,
    preset.enableCommodityScanner
  ),
  enableLiveWebSocket: parseBool(process.env.ENABLE_LIVE_WEBSOCKET, preset.enableLiveWebSocket),
  enableBackgroundPreload: parseBool(
    process.env.ENABLE_BACKGROUND_CANDLE_PRELOAD,
    preset.enableBackgroundPreload
  )
};

flags.needsSmartApiSession =
  flags.enableScannerEngine ||
  flags.enableCustomOptionsScanner ||
  flags.enableLiveWebSocket;

function getActiveLegacyScannerIds() {
  const ids = [];
  if (flags.enableFoScanner) {
    ids.push("fo-bullish", "fo-bearish", "options-bullish", "options-bearish");
  }
  if (flags.enableSwingScanner) ids.push("swing-tracker");
  if (flags.enableIndexScanners) {
    ids.push("nifty-signals", "banknifty-signals", "sensex-signals");
  }
  return ids;
}

function logRuntimeFlags() {
  console.log("[RuntimeFlags] Active profile:", flags.scannerMode);
  console.log("[RuntimeFlags]", JSON.stringify(flags, null, 2));
}

module.exports = {
  ...flags,
  getActiveLegacyScannerIds,
  logRuntimeFlags
};
