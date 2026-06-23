require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const { initializeSession } = require("./services/smartApiSession");
const { loadScripMaster, connectWebSocket } = require("./services/marketDataFeed");
const { startScannerEngine } = require("./services/scannerEngine");

const http = require("http");
const { initSocketServer } = require("./services/socketServer");

const app = express();
const server = http.createServer(app);
initSocketServer(server);
connectDB();

// Initialize Angel One SmartAPI in the background on startup
async function startAngelOne() {
  try {
    if (
      process.env.SMARTAPI_API_KEY &&
      process.env.SMARTAPI_API_KEY !== "YOUR_API_KEY" &&
      process.env.SMARTAPI_CLIENT_CODE !== "YOUR_CLIENT_CODE"
    ) {
      console.log("[SmartAPI] Initializing daily API session...");
      await initializeSession();
      await loadScripMaster();
      // Default subscription list
      await connectWebSocket([
        "Nifty 50", "Nifty Bank", "SENSEX",
        "Nifty Auto", "Nifty Fin Service", "Nifty FMCG", "Nifty IT", "Nifty Media",
        "Nifty Metal", "Nifty Pharma", "Nifty PSU Bank", "Nifty Realty", "Nifty Pvt Bank",
        "Nifty Infra", "Nifty Energy", "Nifty PSE", "Nifty Serv Sector",
        "RELIANCE", "TCS", "INFOSYS", "HDFCBANK", "ICICIBANK", "SBIN",
        "TATAMOTORS", "ITC", "TATASTEEL", "BHARTIRTEL", "SUNPHARMA",
        "JINDALSTEL", "MARUTI", "AXISBANK", "WIPRO", "SUZLON", "YESBANK"
      ]);
    } else {
      console.log("[SmartAPI] Running without live broker credentials. Real-time scanner updates will be limited.");
    }
  } catch (error) {
    console.error("[SmartAPI] Background startup failed:", error.message);
  } finally {
    // Always start the scanner engine, even if the live broker bootstrap failed.
    startScannerEngine();
  }
}
startAngelOne();

app.use(cors());

app.use("/api/webhooks", require("./routes/webhooks"));
app.use(express.json());

app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Trade Screener API</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            font-family: Arial, sans-serif;
            background: #f7faf9;
            color: #14231d;
          }
          main {
            text-align: center;
            padding: 24px;
          }
          h1 {
            margin: 0 0 8px;
            font-size: 28px;
          }
          p {
            margin: 0;
            color: #5d6b65;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Trade Screener API is running</h1>
          <p>Backend service is live and ready.</p>
        </main>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
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

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log("Server running on port " + PORT)
);
