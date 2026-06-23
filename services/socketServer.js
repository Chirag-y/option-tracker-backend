const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

let ioInstance = null;
let onConnectionCallback = null;

function registerOnConnectionCallback(cb) {
  onConnectionCallback = cb;
}

/**
 * Initializes the Socket.IO server bound to the HTTP server instance.
 */
function initSocketServer(httpServer) {
  ioInstance = new Server(httpServer, {
    cors: {
      origin: "*", // In production, restrict this to your frontend URL
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ["websocket"]
  });

  // Authorization middleware
  ioInstance.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error("Authentication error: Token is missing."));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      console.warn(`[Socket] Auth failed for socket ${socket.id}:`, err.message);
      return next(new Error("Authentication error: Invalid Token."));
    }
  });

  ioInstance.on("connection", (socket) => {
    console.log(`⚡ [Socket] Client connected: ${socket.id} (User: ${socket.user?.name || "Unknown"})`);

    if (onConnectionCallback) {
      try {
        onConnectionCallback(socket);
      } catch (err) {
        console.error("[Socket] Connection callback execution failed:", err.message);
      }
    }

    // Latency Ping-Pong handler
    socket.on("ping", (callback) => {
      if (typeof callback === "function") {
        callback();
      }
    });

    // Room-based subscription for individual stocks (e.g. details charts)
    socket.on("subscribe", (symbol) => {
      if (symbol) {
        socket.join(symbol);
        console.log(`⚡ [Socket] Client ${socket.id} subscribed to ticker room: ${symbol}`);
      }
    });

    socket.on("unsubscribe", (symbol) => {
      if (symbol) {
        socket.leave(symbol);
        console.log(`⚡ [Socket] Client ${socket.id} unsubscribed from ticker room: ${symbol}`);
      }
    });

    socket.on("disconnect", (reason) => {
      console.log(`⚡ [Socket] Client disconnected: ${socket.id} (Reason: ${reason})`);
    });
  });

  return ioInstance;
}

/**
 * Broadcasts a price update to all clients subscribed to a specific stock's ticker room.
 */
function broadcastPriceUpdate(symbol, price, changePercent) {
  if (!ioInstance) return;
  ioInstance.to(symbol).emit("price-update", { symbol, price, changePercent });
}

/**
 * Broadcasts a list update for a specific scanner segment to all connected clients.
 */
function broadcastScannerUpdate(scannerId, data) {
  if (!ioInstance) return;
  ioInstance.emit("scanner-update", { scannerId, data });
}

/**
 * Broadcasts a real-time signal alert to all connected clients.
 */
function broadcastNewSignal(signalData) {
  if (!ioInstance) return;
  ioInstance.emit("new-signal", signalData);
}

/**
 * Broadcasts sector strength updates.
 */
function broadcastSectorUpdate(sectorsData) {
  if (!ioInstance) return;
  ioInstance.emit("sector-update", sectorsData);
}

/**
 * Broadcasts market overview statistics.
 */
function broadcastMarketOverview(overviewData) {
  if (!ioInstance) return;
  ioInstance.emit("market-overview", overviewData);
}

/**
 * Retrieves all stock symbols that have active client subscriptions.
 */
function getSubscribedSymbols() {
  if (!ioInstance) return [];
  const rooms = ioInstance.sockets.adapter.rooms;
  const symbols = [];
  for (const [key, value] of rooms.entries()) {
    const isSocketId = ioInstance.sockets.sockets.has(key);
    if (!isSocketId && key !== undefined) {
      symbols.push(key);
    }
  }
  return symbols;
}

module.exports = {
  initSocketServer,
  broadcastPriceUpdate,
  broadcastScannerUpdate,
  broadcastNewSignal,
  broadcastSectorUpdate,
  broadcastMarketOverview,
  registerOnConnectionCallback,
  getSubscribedSymbols
};
