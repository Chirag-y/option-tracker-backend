/**
 * Socket.IO server  (Phase 5 polish)
 * ----------------------------------
 * Enhancements over the original:
 *   - perMessageDeflate compression           (Phase 5)
 *   - Delta broadcasts for scanner-update     (Phase 5)
 *   - Per-scanner rooms (clients only get the scanner they're viewing)
 *   - Polling fallback restored               (websocket-only broke mobile)
 */
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

let ioInstance = null;
let onConnectionCallback = null;

// Per-scanner last-broadcast snapshot, used to compute deltas.
const _lastScannerPayload = new Map(); // scannerId -> Map<symbol, signature>

function registerOnConnectionCallback(cb) { onConnectionCallback = cb; }

function initSocketServer(httpServer) {
  ioInstance = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    perMessageDeflate: {
      threshold: 1024,            // only compress payloads >= 1 KB
      zlibDeflateOptions: { level: 3 },
    },
    pingInterval: 25_000,
    pingTimeout:  30_000,
  });

  ioInstance.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication error: Token is missing."));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      console.warn(`[Socket] Auth failed for socket ${socket.id}:`, err.message);
      return next(new Error("Authentication error: Invalid Token."));
    }
  });

  ioInstance.on("connection", (socket) => {
    console.log(`⚡ [Socket] Connected: ${socket.id} (User: ${socket.user?.name || "Unknown"})`);
    if (onConnectionCallback) {
      try { onConnectionCallback(socket); }
      catch (err) { console.error("[Socket] Connection callback failed:", err.message); }
    }

    socket.on("ping", (cb) => { if (typeof cb === "function") cb(); });

    // Per-symbol room (existing)
    socket.on("subscribe",   (symbol) => { if (symbol) socket.join(symbol); });
    socket.on("unsubscribe", (symbol) => { if (symbol) socket.leave(symbol); });

    // NEW: per-scanner room — `scanner:swing-tracker` etc.
    socket.on("subscribe-scanner",   (scannerId) => { if (scannerId) socket.join(`scanner:${scannerId}`); });
    socket.on("unsubscribe-scanner", (scannerId) => { if (scannerId) socket.leave(`scanner:${scannerId}`); });

    socket.on("disconnect", (reason) => {
      console.log(`⚡ [Socket] Disconnected: ${socket.id} (${reason})`);
    });
  });

  return ioInstance;
}

function broadcastPriceUpdate(symbol, price, changePercent) {
  if (!ioInstance) return;
  ioInstance.emit("price-update", { symbol, price, changePercent });
}

/**
 * Delta-aware scanner broadcaster.
 *
 *  - For each signal, builds a compact signature; only signals whose signature
 *    changed are included in the emit payload.
 *  - Emits on the per-scanner room (`scanner:<id>`) AND globally for backward
 *    compatibility with existing frontend code.
 */
function _signature(row) {
  // Lightweight stringified subset — enough to detect meaningful changes.
  return `${row.price ?? ""}|${row.change ?? ""}|${row.direction ?? ""}|${row.signalStrength ?? ""}|${row.strengthScore ?? ""}`;
}

function broadcastScannerUpdate(scannerId, data) {
  if (!ioInstance) return;
  const prev = _lastScannerPayload.get(scannerId) || new Map();
  const next = new Map();
  const changed = [];

  if (Array.isArray(data)) {
    for (const row of data) {
      const sig = _signature(row);
      next.set(row.symbol, sig);
      if (prev.get(row.symbol) !== sig) changed.push(row);
    }
    // Detect removed rows so the client can drop them.
    const removed = [];
    for (const sym of prev.keys()) if (!next.has(sym)) removed.push(sym);

    _lastScannerPayload.set(scannerId, next);

    // Full payload on first ever broadcast for the scanner; deltas thereafter.
    const isFirst = prev.size === 0;
    const payload = isFirst
      ? { scannerId, full: true,  data, removed: [] }
      : { scannerId, full: false, data: changed, removed };

    if (isFirst || changed.length > 0 || removed.length > 0) {
      ioInstance.to(`scanner:${scannerId}`).emit("scanner-update", payload);
      // Back-compat: also emit globally (deprecated path).
      ioInstance.emit("scanner-update", payload);
    }
  } else {
    // Non-array payloads pass through unchanged.
    ioInstance.to(`scanner:${scannerId}`).emit("scanner-update", { scannerId, data });
    ioInstance.emit("scanner-update", { scannerId, data });
  }
}

function broadcastNewSignal(signalData) {
  if (!ioInstance) return;
  // Route to per-scanner room if scannerId is present, plus global for legacy clients.
  if (signalData?.scannerId) {
    ioInstance.to(`scanner:${signalData.scannerId}`).emit("new-signal", signalData);
  }
  ioInstance.emit("new-signal", signalData);
}

function broadcastSectorUpdate(sectorsData) {
  if (!ioInstance) return;
  ioInstance.emit("sector-update", sectorsData);
}

function broadcastMarketOverview(overviewData) {
  if (!ioInstance) return;
  ioInstance.emit("market-overview", overviewData);
}

function getSubscribedSymbols() {
  if (!ioInstance) return [];
  const rooms = ioInstance.sockets.adapter.rooms;
  const symbols = [];
  for (const [key] of rooms.entries()) {
    if (!ioInstance.sockets.sockets.has(key) && key !== undefined && !key.startsWith("scanner:")) {
      symbols.push(key);
    }
  }
  return symbols;
}

function getStats() {
  if (!ioInstance) return { connected: 0, rooms: 0 };
  return {
    connected: ioInstance.sockets.sockets.size,
    rooms:     ioInstance.sockets.adapter.rooms.size,
    scannerSnapshots: _lastScannerPayload.size,
  };
}

module.exports = {
  initSocketServer,
  broadcastPriceUpdate,
  broadcastScannerUpdate,
  broadcastNewSignal,
  broadcastSectorUpdate,
  broadcastMarketOverview,
  registerOnConnectionCallback,
  getSubscribedSymbols,
  getStats,
};
