/**
 * Shared helpers for F&O active-trade P&L and IST time handling.
 */

function getIstHm(dt) {
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return { h: 0, m: 0 };
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return { h, m };
}

function computeFoPnlPct(direction, entryPrice, exitPrice) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!entry || !exit) return 0;
  const raw = direction === "BEARISH"
    ? (entry - exit) / entry
    : (exit - entry) / entry;
  return Number((raw * 100).toFixed(2));
}

function closeFoTradeRecord(tr, exitPrice, closedAt) {
  tr.status = "CLOSED";
  tr.closedAt = closedAt;
  tr.exitPrice = exitPrice;
  tr.pnlPct = computeFoPnlPct(tr.direction, tr.entryPrice, exitPrice);
}

/** Keep one ACTIVE row per symbol (latest trigger); retain all CLOSED. */
function dedupeFoTradesBySymbol(trades) {
  const openBySymbol = new Map();
  const closed = [];
  for (const t of trades) {
    if (t.status === "ACTIVE") {
      const prev = openBySymbol.get(t.symbol);
      if (!prev || new Date(t.triggeredAt) > new Date(t.triggeredAt)) {
        openBySymbol.set(t.symbol, t);
      }
    } else {
      closed.push(t);
    }
  }
  return [...closed, ...openBySymbol.values()];
}

module.exports = {
  getIstHm,
  computeFoPnlPct,
  closeFoTradeRecord,
  dedupeFoTradesBySymbol,
};
