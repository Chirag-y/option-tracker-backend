/**
 * CommodityContractManager
 * ------------------------
 * Owns the lifecycle of MCX commodity futures contracts.
 *
 *   Server start         -> syncCommodityContracts()
 *   Daily 08:30 IST      -> syncCommodityContracts()  (detect expiry rollover)
 *
 * It diffs against the previous active contracts; on rollover the LiveUniverseManager
 * picks up the change in its next refresh and (un)subscribes accordingly.
 *
 * Source: Angel One Scrip Master already parsed by services/marketDataFeed.js
 * (no extra HTTP call here — re-uses the in-memory symbolToTokenMap).
 */
const CommodityContract = require("../models/CommodityContract");

const COMMODITY_MASTER = ["CRUDEOIL", "GOLD", "GOLDM", "SILVER", "SILVERM", "COPPER"];

function pickNearestActive(instruments, today = new Date()) {
  return instruments
    .filter(i => i.expiry && new Date(i.expiry).getTime() >= today.getTime())
    .sort((a, b) => new Date(a.expiry) - new Date(b.expiry))[0];
}

/**
 * @param {Object} deps
 * @param {Object} deps.symbolToTokenMap marketDataFeed.symbolToTokenMap
 */
async function syncCommodityContracts({ symbolToTokenMap } = {}) {
  if (!symbolToTokenMap || Object.keys(symbolToTokenMap).length === 0) {
    console.warn("[CommodityContractManager] Scrip master not loaded yet; skipping sync.");
    return { added: 0, rolled: 0, total: 0, rollovers: [] };
  }

  const today = new Date();
  let added = 0, rolled = 0;
  const rollovers = [];
  const activeSymbols = [];

  for (const commodity of COMMODITY_MASTER) {
    const candidates = Object.values(symbolToTokenMap).filter(
      i =>
        i.segment === "MCX" &&
        typeof i.symbol === "string" &&
        i.symbol.startsWith(commodity) &&
        i.instrumenttype !== "OPTFUT" && // futures only
        i.expiry
    );

    const nearest = pickNearestActive(candidates, today);
    if (!nearest) continue;

    const previous = await CommodityContract.findOne({ commodity, active: true });

    if (!previous) {
      await CommodityContract.create({
        commodity,
        symbol:   nearest.symbol,
        token:    String(nearest.token),
        exchange: "MCX",
        expiry:   new Date(nearest.expiry),
        lotsize:  nearest.lotsize || 1,
        active:   true,
      });
      added += 1;
    } else if (previous.symbol !== nearest.symbol) {
      // Rollover: deactivate previous, insert new.
      await CommodityContract.updateOne(
        { _id: previous._id },
        { $set: { active: false, updatedAt: today } }
      );
      await CommodityContract.create({
        commodity,
        symbol:   nearest.symbol,
        token:    String(nearest.token),
        exchange: "MCX",
        expiry:   new Date(nearest.expiry),
        lotsize:  nearest.lotsize || 1,
        active:   true,
      });
      rolled += 1;
      rollovers.push({ commodity, from: previous.symbol, to: nearest.symbol });
      console.log(`[CommodityContractManager] Rollover ${commodity}: ${previous.symbol} -> ${nearest.symbol}`);
    } else {
      // Same contract — just touch updatedAt.
      await CommodityContract.updateOne(
        { _id: previous._id },
        { $set: { expiry: new Date(nearest.expiry), updatedAt: today } }
      );
    }
    activeSymbols.push(nearest.symbol);
  }

  return { added, rolled, total: activeSymbols.length, rollovers, activeSymbols };
}

async function getActiveCommodityUniverse() {
  const docs = await CommodityContract.find({ active: true })
    .select("commodity symbol token exchange expiry")
    .lean();
  return docs.map(d => ({
    commodity: d.commodity,
    symbol:    d.symbol,
    token:     d.token,
    segment:   d.exchange || "MCX",
    expiry:    d.expiry,
    source:    "commodity",
  }));
}

module.exports = { syncCommodityContracts, getActiveCommodityUniverse, COMMODITY_MASTER };
