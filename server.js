require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const app = express();
connectDB();

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
        <title>Option Tracker API</title>
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
          <h1>Option Tracker API is running</h1>
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
app.use("/api/trades", require("./routes/trades"));
app.use("/api/users", require("./routes/users"));
app.use("/api/calendar", require("./routes/calendar"));
app.use("/api/charts", require("./routes/charts"));
app.use("/api/export", require("./routes/export"));
app.use("/api/admin", require("./routes/admin"));

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log("Server running on port " + PORT)
);
