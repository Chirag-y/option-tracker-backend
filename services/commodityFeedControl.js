/**
 * Runtime pause/resume for commodity websocket feed + commodity-momentum scanner.
 * Does not affect F&O or index scanners. Helps reduce websocket + CPU load.
 */
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "../config/commodityFeedState.json");

let paused = false;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      paused = raw.paused === true;
    }
  } catch {
    paused = false;
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ paused, updatedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.warn("[CommodityFeedControl] Failed to persist state:", err.message);
  }
}

function isCommodityFeedPaused() {
  return paused;
}

async function setCommodityFeedPaused(nextPaused) {
  paused = !!nextPaused;
  saveState();

  const scannerRegistry = require("./scannerRegistry");
  scannerRegistry.setEnabled("commodity-momentum", !paused);

  try {
    const LiveUniverseManager = require("./liveUniverseManager");
    await LiveUniverseManager.refreshNow({ skipSync: paused });
  } catch (err) {
    console.warn("[CommodityFeedControl] Universe refresh after pause toggle:", err.message);
  }

  console.log(`[CommodityFeedControl] Commodity feed ${paused ? "PAUSED" : "RESUMED"}`);
  return { paused };
}

function getCommodityFeedStatus() {
  return { paused };
}

loadState();

module.exports = {
  isCommodityFeedPaused,
  setCommodityFeedPaused,
  getCommodityFeedStatus,
};
