require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const app = express();
connectDB();

app.use(cors());
app.use(express.json());

app.use("/api/auth", require("./routes/auth"));
app.use("/api/trades", require("./routes/trades"));
app.use("/api/users", require("./routes/users"));
app.use("/api/calendar", require("./routes/calendar"));
app.use("/api/charts", require("./routes/charts"));
app.use("/api/export", require("./routes/export"));

app.listen(process.env.PORT, () =>
  console.log("Server running on port " + process.env.PORT)
);