/**
 * Index option strike catalog — reads Angel scripMaster OPTIDX rows and exposes
 * human-friendly strike lists for the Custom Options UI.
 */
const path = require("path");
const fs = require("fs");

const INDEX_MAP = {
  nifty: "NIFTY",
  banknifty: "BANKNIFTY",
  sensex: "SENSEX",
};

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

let _scripMaster = null;

function loadScripMaster() {
  if (_scripMaster) return _scripMaster;
  const filePath = path.join(__dirname, "../config/scripMaster.json");
  _scripMaster = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return _scripMaster;
}

function parseExpiry(expiryStr) {
  const m = String(expiryStr || "").match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = MONTHS[m[2]];
  const year = parseInt(m[3], 10);
  if (mon === undefined) return null;
  return new Date(Date.UTC(year, mon, day));
}

function strikeFromRow(row) {
  const raw = parseFloat(row.strike);
  if (!Number.isFinite(raw)) return null;
  return Math.round(raw / 100);
}

function resolveIndexName(indexKey) {
  return INDEX_MAP[String(indexKey || "nifty").toLowerCase()] || null;
}

function listExpiries(indexKey) {
  const name = resolveIndexName(indexKey);
  if (!name) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const set = new Set();
  for (const row of loadScripMaster()) {
    if (row.instrumenttype !== "OPTIDX" || row.name !== name) continue;
    const d = parseExpiry(row.expiry);
    if (!d || d < today) continue;
    set.add(row.expiry);
  }

  return [...set].sort((a, b) => {
    const da = parseExpiry(a);
    const db = parseExpiry(b);
    return (da?.getTime() || 0) - (db?.getTime() || 0);
  });
}

function getNearestExpiry(indexKey) {
  const expiries = listExpiries(indexKey);
  return expiries[0] || null;
}

function getStrikesForIndex(indexKey, expiry = null) {
  const name = resolveIndexName(indexKey);
  if (!name) {
    return { index: indexKey, expiry: null, expiries: [], callStrikes: [], putStrikes: [] };
  }

  const expiries = listExpiries(indexKey);
  const chosenExpiry = expiry && expiries.includes(expiry) ? expiry : expiries[0];
  if (!chosenExpiry) {
    return { index: indexKey, indexName: name, expiry: null, expiries, callStrikes: [], putStrikes: [] };
  }

  const callStrikes = [];
  const putStrikes = [];

  for (const row of loadScripMaster()) {
    if (row.instrumenttype !== "OPTIDX" || row.name !== name || row.expiry !== chosenExpiry) continue;
    const strike = strikeFromRow(row);
    if (strike == null) continue;
    const entry = {
      strike,
      symbol: row.symbol,
      token: row.token,
      expiry: row.expiry,
      exchange: row.exch_seg,
    };
    if (row.symbol.endsWith("CE")) callStrikes.push(entry);
    else if (row.symbol.endsWith("PE")) putStrikes.push(entry);
  }

  const byStrike = (a, b) => a.strike - b.strike;
  callStrikes.sort(byStrike);
  putStrikes.sort(byStrike);

  return {
    index: indexKey,
    indexName: name,
    expiry: chosenExpiry,
    expiries,
    callStrikes,
    putStrikes,
  };
}

/** Resolve broker token for an exact option symbol (scripMaster is authoritative). */
function resolveOptionInstrument(symbol) {
  if (!symbol) return null;
  const key = String(symbol).toUpperCase();

  const row = loadScripMaster().find(r => r.symbol === key);
  if (row) {
    return {
      token: row.token,
      segment: row.exch_seg,
      symbol: row.symbol,
      expiry: row.expiry,
    };
  }

  try {
    const { symbolToTokenMap } = require("./marketDataFeed");
    const live = symbolToTokenMap[key];
    if (live?.token) {
      return {
        token: live.token,
        segment: live.segment || live.exch_seg,
        symbol: live.symbol || key,
        expiry: live.expiry,
      };
    }
  } catch { /* market feed not ready */ }

  return null;
}

module.exports = {
  INDEX_MAP,
  resolveIndexName,
  listExpiries,
  getNearestExpiry,
  getStrikesForIndex,
  resolveOptionInstrument,
  parseExpiry,
};
