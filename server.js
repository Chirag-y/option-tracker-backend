/**
 * Patched server.js
 * -----------------
 * Wires up the LiveUniverseManager so the only websocket subscriptions are the
 * merged live universe (~250–330 symbols) instead of the previous default
 * subscription list + scannerEngine's bulk FO_UNIVERSE subscribe.
 *
 * Key changes from original:
 *   - Removes the hard-coded `connectWebSocket([...big list of indices + stocks])`
 *     call. We still open the websocket, but with an EMPTY subscription set,
 *     then immediately ask LiveUniverseManager to reconcile.
 *   - Initializes the LiveUniverseManager and schedules its 08:30 IST daily refresh.
 *   - Exposes /api/admin/live-universe for observability.
 */
require("dotenv").config();
const runtimeFlags = require("./config/runtimeFlags");
runtimeFlags.logRuntimeFlags();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const { initializeSession } = require("./services/smartApiSession");
const {
  loadScripMaster,
  connectWebSocket,
  subscribeToSymbols,
  unsubscribeFromSymbols,
  symbolToTokenMap,
} = require("./services/marketDataFeed");
const { startScannerEngine, evictSymbolsFromCandleCache } = require("./services/scannerEngine");
const LiveUniverseManager   = require("./services/liveUniverseManager");
const scannerManager        = require("./services/scannerManager");
const healthMonitor         = require("./services/healthMonitor");
const dailyCandleStore      = require("./services/dailyCandleStore");
const DailyCandle           = require("./models/DailyCandle");
const EodScanState          = require("./models/EodScanState");

const http = require("http");
const { initSocketServer } = require("./services/socketServer");

const app = express();
const server = http.createServer(app);
initSocketServer(server);
connectDB();

async function startAngelOne() {
  try {
    const hasSmartApiCreds =
      process.env.SMARTAPI_API_KEY &&
      process.env.SMARTAPI_API_KEY !== "YOUR_API_KEY" &&
      process.env.SMARTAPI_CLIENT_CODE !== "YOUR_CLIENT_CODE";

    if (hasSmartApiCreds && runtimeFlags.needsSmartApiSession) {
      console.log("[SmartAPI] Initializing daily API session...");
      await initializeSession();
      await loadScripMaster();

      if (runtimeFlags.enableLiveWebSocket) {
        // Open the websocket with NO pre-baked symbols.
        // LiveUniverseManager will subscribe only the merged universe.
        await connectWebSocket([]);

        LiveUniverseManager.init({
          subscribeToSymbols,
          unsubscribeFromSymbols,
          symbolToTokenMap,
          onSymbolsRemoved: evictSymbolsFromCandleCache,
        });
        await LiveUniverseManager.refreshNow();
        LiveUniverseManager.scheduleDailyRefresh();
      } else {
        console.log("[SmartAPI] Live WebSocket disabled — REST-only SmartAPI mode.");
      }
    } else if (!hasSmartApiCreds) {
      console.log("[SmartAPI] Running without live broker credentials. Real-time scanner updates will be limited.");
    } else {
      console.log("[SmartAPI] SmartAPI session skipped — no scanners require live market data.");
    }
  } catch (error) {
    console.error("[SmartAPI] Background startup failed:", error.message);
  } finally {
    if (runtimeFlags.enableScannerEngine) {
      startScannerEngine();
    } else {
      console.log("[ScannerEngine] Skipped — disabled by runtime flags.");
    }

    if (runtimeFlags.enableCustomOptionsScanner) {
      require("./services/customOptionsEngine");
      console.log("[CustomOptionsEngine] Live alert scanner scheduled (market hours, ~90s interval)");
    } else {
      console.log("[CustomOptionsEngine] Skipped — disabled by runtime flags.");
    }

    if (runtimeFlags.enableCommodityScanner) {
      try {
        const scannerRegistry = require("./services/scannerRegistry");
        const commodityScanner = require("./services/commodityScanner");
        commodityScanner.register(scannerRegistry);
        const commodityFeedControl = require("./services/commodityFeedControl");
        scannerRegistry.setEnabled("commodity-momentum", !commodityFeedControl.isCommodityFeedPaused());
        scannerManager.start();
      } catch (e) {
        console.warn("[Server] Commodity scanner registration skipped:", e.message);
      }
    } else {
      console.log("[ScannerManager] Skipped — commodity scanner disabled.");
    }

    healthMonitor.start();
  }
}
// Phase 4 polish — defer HTTP server.listen() until startAngelOne() resolves so
// the commodity universe (synced inside LiveUniverseManager.refreshNow) is in
// Mongo before the first /api/scanner/commodities request can arrive.
// 12-second safety timeout so a slow SmartAPI login never blocks the API
// indefinitely — if startup hasn't finished by then we listen anyway with a
// warning (legacy in-memory fallback will serve until sync completes).
const STARTUP_TIMEOUT_MS = 12_000;
const startupPromise = Promise.race([
  startAngelOne(),
  new Promise(resolve => setTimeout(() => {
    console.warn(`[Server] Startup did not finish within ${STARTUP_TIMEOUT_MS}ms — beginning to serve traffic anyway.`);
    resolve("timeout");
  }, STARTUP_TIMEOUT_MS)),
]);

app.use(cors());
app.use("/api/webhooks", require("./routes/webhooks"));
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><body><h1>Trade Screener API is running</h1></body></html>`);
});
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    scannerMode: runtimeFlags.scannerMode,
    disableEodSwingScan: runtimeFlags.disableEodSwingScan
  })
);

// Observability endpoint for the Live Universe
app.get("/api/admin/live-universe", (_req, res) => {
  res.json({
    summary: LiveUniverseManager.getSummary(),
    universe: LiveUniverseManager.getUniverse().map(u => ({
      symbol: u.symbol,
      name:   u.name,
      sources: Array.from(u.sources),
      isFO:   u.isFO,
    })),
  });
});
app.post("/api/admin/live-universe/refresh", async (_req, res) => {
  try {
    const summary = await LiveUniverseManager.refreshNow();
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 7 — scanner registry + alert stats
app.get("/api/admin/scanner-manager", (_req, res) => {
  res.json(scannerManager.getStatus());
});
app.get("/api/admin/alerts/stats", (_req, res) => {
  res.json(require("./services/alertManager").getStats());
});

// Phase 8 — health monitoring
app.get("/api/admin/health", (_req, res) => {
  res.json({ current: healthMonitor.snapshot(), history: healthMonitor.history() });
});

// Phase 3 — commodity scanner settings
app.get("/api/admin/commodity-settings", (_req, res) => {
  res.json(require("./config/commodityScannerSettings").listCommoditySettings());
});

/**
 * Phase 1 / observability — EOD scan status snapshot.
 *
 * GET /api/admin/eod-status[?days=7]
 *
 * Returns:
 *   {
 *     today: { date, startedAt, completedAt, symbolsFetched, symbolsSkipped, triggers } | null,
 *     completedToday: bool,
 *     dailyCandlesCount: number,                 // total docs in DailyCandle
 *     distinctSymbols: number,                   // distinct symbols persisted
 *     recent: [...]                              // last N scan states (default 7)
 *   }
 */
app.get("/api/admin/eod-status", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 60);
    const todayIst = dailyCandleStore.getIstTradingDate();

    const [today, recent, dailyCandlesCount, distinctSymbols] = await Promise.all([
      EodScanState.findOne({ date: todayIst }).lean(),
      EodScanState.find().sort({ date: -1 }).limit(days).lean(),
      DailyCandle.estimatedDocumentCount(),
      DailyCandle.distinct("symbol").then(arr => arr.length).catch(() => 0),
    ]);

    res.json({
      ok: true,
      todayIst,
      today: today || null,
      completedToday: Boolean(today && today.completedAt),
      dailyCandlesCount,
      distinctSymbols,
      recent,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use("/api/auth", require("./routes/auth"));
app.use("/api/scanner", require("./routes/scanner"));
app.use("/api/trades", require("./routes/trades"));
app.use("/api/users", require("./routes/users"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/calendar", require("./routes/calendar"));
app.use("/api/charts", require("./routes/charts"));
app.use("/api/export", require("./routes/export"));
app.use("/api/admin", require("./routes/admin"));

app.use((req, res) => res.status(404).json({ message: "Route not found" }));

const PORT = process.env.PORT || 5000;
// Phase 4 polish — wait for startAngelOne() (which awaits LiveUniverseManager
// .refreshNow → syncCommodityContracts) before opening the HTTP port, so the
// first /api/scanner/commodities call finds the Mongo-backed universe ready.
startupPromise.then(() => {
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[Server] Port ${PORT} is already in use. Stop the other backend process first (taskkill /F /IM node.exe) or set PORT in .env.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => console.log("Server running on port " + PORT));
});
