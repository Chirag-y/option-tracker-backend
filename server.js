require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const app = express();
connectDB();

app.use(cors());
app.use(express.json());

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
