/**
 * FoUniverseSync
 * --------------
 * Syncs the active F&O universe into MongoDB (collection: InstrumentUniverse).
 *
 * Strategy:
 *   1. Seed from existing config/foUniverse.js on first boot (zero-downtime migration).
 *   2. Then prefer the Angel One Scrip Master (already downloaded by marketDataFeed):
 *        - any NFO instrument whose underlying name is in our equity universe is flagged isFO=true
 *   3. Mark stale symbols active=false (no longer in F&O) but keep the row for audit.
 *
 * Runs once on boot, then daily at 09:00 IST (configurable).
 *
 * NOTE: This file does NOT make HTTP calls itself. It reuses the Scrip Master
 * already maintained by services/marketDataFeed.js (symbolToTokenMap),
 * keeping resource usage low.
 */
const InstrumentUniverse = require("../models/InstrumentUniverse");
const FO_UNIVERSE_SEED   = require("../config/foUniverse");

/**
 * @param {Object} deps
 * @param {Object} deps.symbolToTokenMap  marketDataFeed.symbolToTokenMap reference
 */
async function syncFoUniverse({ symbolToTokenMap } = {}) {
  try {
    const now = new Date();

    // --- 1. Seed (idempotent upsert from foUniverse.js) ---
    const bulkSeed = FO_UNIVERSE_SEED.map(s => ({
      updateOne: {
        filter: { symbol: s.symbol },
        update: {
          $set: {
            name:        s.name || s.symbol,
            exchange:    "NSE",
            segment:     "NSE",
            isFO:        true,
            isEquity:    true,
            active:      true,
            lastUpdated: now,
          },
        },
        upsert: true,
      },
    }));
    if (bulkSeed.length) await InstrumentUniverse.bulkWrite(bulkSeed, { ordered: false });

    // --- 2. Cross-validate against Angel One scrip master if available ---
    if (symbolToTokenMap && Object.keys(symbolToTokenMap).length > 0) {
      const liveFoNames = new Set();
      for (const inst of Object.values(symbolToTokenMap)) {
        if (inst.segment === "NFO" && inst.instrumenttype === "FUTSTK" && inst.name) {
          liveFoNames.add(inst.name);
        }
      }

      if (liveFoNames.size > 0) {
        // Mark active=true for everything currently in the live NFO list.
        const ops = [];
        for (const name of liveFoNames) {
          ops.push({
            updateOne: {
              filter: { symbol: name },
              update: {
                $set: { isFO: true, active: true, lastUpdated: now },
                $setOnInsert: { name, exchange: "NSE", segment: "NSE", isEquity: true },
              },
              upsert: true,
            },
          });
        }
        if (ops.length) await InstrumentUniverse.bulkWrite(ops, { ordered: false });

        // Deactivate any previously-active F&O symbol that is no longer present
        // (only if the scrip master returned a non-trivial number of symbols — protects
        // against a partial Scrip Master download wiping the universe).
        if (liveFoNames.size > 50) {
          await InstrumentUniverse.updateMany(
            { isFO: true, active: true, symbol: { $nin: Array.from(liveFoNames) } },
            { $set: { active: false, lastUpdated: now } }
          );
        }
      }
    }

    const totalActive = await InstrumentUniverse.countDocuments({ isFO: true, active: true });
    console.log(`[FoUniverseSync] Sync complete. Active F&O symbols: ${totalActive}`);
    return totalActive;
  } catch (err) {
    console.error("[FoUniverseSync] Sync failed:", err.message);
    return 0;
  }
}

async function getActiveFoUniverse() {
  const docs = await InstrumentUniverse.find({ isFO: true, active: true })
    .select("symbol name sector isFO")
    .lean();
  if (docs.length > 0) {
    return docs.map(d => ({
      symbol: d.symbol,
      name:   d.name || d.symbol,
      sector: d.sector || "",
      isFO:   true,
      source: "fo",
    }));
  }
  // Cold-boot fallback (DB empty) — never crash, fall back to seed list.
  return FO_UNIVERSE_SEED.map(s => ({
    symbol: s.symbol, name: s.name, sector: "", isFO: true, source: "fo",
  }));
}

module.exports = { syncFoUniverse, getActiveFoUniverse };
