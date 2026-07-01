const fs = require("fs");

const content = fs.readFileSync("D:\\MERN\\Option Tracker\\backend\\services\\scannerEngine.js", "utf-8");
const lines = content.split("\n");

lines.forEach((line, idx) => {
  if (line.includes("niftyPrice") || line.includes("bankNiftyPrice") || line.includes("sensexPrice")) {
    console.log(`${idx + 1}: ${line}`);
  }
});
