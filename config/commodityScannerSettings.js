/**
 * Commodity Scanner Settings  (Phase 3)
 * -------------------------------------
 * Per-commodity overrides for scanner thresholds, tick / volatility
 * profiles, and lot sizes. Used by scanners that operate on the MCX
 * universe so that, e.g., CRUDEOIL doesn't share the same volume /
 * strength thresholds as GOLDM.
 *
 * Looked up by the *base* commodity name (CRUDEOIL, GOLD, GOLDM, ...).
 * Fall back to DEFAULT for any commodity not explicitly listed.
 *
 * Field reference:
 *   - tickSize:        smallest price increment for the contract
 *   - lotSize:         exchange lot multiplier (informational; live truth
 *                      comes from CommodityContract.lotsize)
 *   - volatilityClass: "HIGH" | "MEDIUM" | "LOW"  — drives strength scoring
 *   - minVolume:       reject ticks below this 5-min volume floor
 *   - atrPeriod:       ATR window for SL / breakout calcs
 *   - rsiOverbought / rsiOversold
 *   - breakoutPct:     % above N-bar high to confirm a breakout
 *   - strengthFloor:   minimum strength score required to broadcast a signal
 *   - scanIntervalMs:  preferred scanner cadence (commodities trade slower
 *                      than NSE EQ; default 60 s is fine for most)
 */

const DEFAULT = {
  tickSize:        0.05,
  lotSize:         1,
  volatilityClass: "MEDIUM",
  minVolume:       100,
  atrPeriod:       14,
  rsiOverbought:   70,
  rsiOversold:     30,
  breakoutPct:     0.40,
  strengthFloor:   50,
  scanIntervalMs:  60_000,
};

const SETTINGS = {
  CRUDEOIL: {
    ...DEFAULT,
    tickSize:        1,
    lotSize:         100,
    volatilityClass: "HIGH",
    minVolume:       250,
    atrPeriod:       14,
    rsiOverbought:   72,
    rsiOversold:     28,
    breakoutPct:     0.60,
    strengthFloor:   55,
    scanIntervalMs:  30_000,   // crude moves fast; tighter scan window
  },
  GOLD: {
    ...DEFAULT,
    tickSize:        1,
    lotSize:         100,
    volatilityClass: "MEDIUM",
    minVolume:       150,
    atrPeriod:       14,
    rsiOverbought:   70,
    rsiOversold:     30,
    breakoutPct:     0.30,
    strengthFloor:   55,
  },
  GOLDM: {
    ...DEFAULT,
    tickSize:        1,
    lotSize:         10,
    volatilityClass: "LOW",
    minVolume:       60,
    breakoutPct:     0.25,
    strengthFloor:   50,
  },
  SILVER: {
    ...DEFAULT,
    tickSize:        1,
    lotSize:         30,
    volatilityClass: "HIGH",
    minVolume:       120,
    breakoutPct:     0.55,
    strengthFloor:   55,
  },
  SILVERM: {
    ...DEFAULT,
    tickSize:        1,
    lotSize:         5,
    volatilityClass: "MEDIUM",
    minVolume:       40,
    breakoutPct:     0.35,
    strengthFloor:   50,
  },
  COPPER: {
    ...DEFAULT,
    tickSize:        0.05,
    lotSize:         2500,
    volatilityClass: "MEDIUM",
    minVolume:       80,
    breakoutPct:     0.30,
    strengthFloor:   50,
  },
};

/**
 * Extract the base commodity name from a contract symbol.
 * "CRUDEOIL20JUL26FUT" -> "CRUDEOIL"
 */
function baseCommodity(symbol = "") {
  for (const name of Object.keys(SETTINGS)) {
    if (symbol.startsWith(name)) return name;
  }
  return null;
}

function getCommoditySettings(symbol) {
  if (!symbol) return DEFAULT;
  const base = baseCommodity(symbol) || symbol;
  return SETTINGS[base] || DEFAULT;
}

function listCommoditySettings() {
  return Object.entries(SETTINGS).map(([name, cfg]) => ({ name, ...cfg }));
}

module.exports = {
  getCommoditySettings,
  listCommoditySettings,
  baseCommodity,
  DEFAULT,
};
