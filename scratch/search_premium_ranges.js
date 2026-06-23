const fs = require("fs");
const path = require("path");

const content = fs.readFileSync("C:\\Users\\Chirag\\.gemini\\antigravity\\brain\\2e5b34b5-2198-44c9-92f0-5f8eb074ff20\\scratch\\all_user_requests.txt", "utf-8");
const lines = content.split("\n");

console.log("Total lines in file:", lines.length);
lines.forEach((line, idx) => {
  const l = line.toLowerCase();
  if (l.includes("200") || l.includes("250") || l.includes("premium")) {
    console.log(`${idx + 1}: ${line}`);
  }
});
