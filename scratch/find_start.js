const fs = require("fs");

const content = fs.readFileSync("D:\\MERN\\Option Tracker\\backend\\services\\scannerEngine.js", "utf-8");
const lines = content.split("\n");

lines.forEach((line, idx) => {
  if (line.includes("function startScannerEngine") || line.includes("async function startScannerEngine")) {
    console.log(`${idx + 1}: ${line}`);
  }
});
