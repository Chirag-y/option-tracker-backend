const fs = require("fs");
const path = require("path");

const enginePath = "D:\\MERN\\Option Tracker\\backend\\services\\scannerEngine.js";
const content = fs.readFileSync(enginePath, "utf-8");
const lines = content.split("\n");

lines.forEach((line, idx) => {
  if (line.includes("generateIndexTrades")) {
    console.log(`${idx + 1}: ${line}`);
  }
});
