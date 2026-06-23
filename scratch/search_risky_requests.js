const fs = require("fs");
const path = require("path");

const content = fs.readFileSync("C:\\Users\\Chirag\\.gemini\\antigravity\\brain\\2e5b34b5-2198-44c9-92f0-5f8eb074ff20\\scratch\\all_user_requests.txt", "utf-8");
const lines = content.split("\n");

lines.forEach((line, idx) => {
  if (line.toLowerCase().includes("risky") || line.toLowerCase().includes("avoid") || line.toLowerCase().includes("hull") || line.toLowerCase().includes("hma")) {
    console.log(`${idx + 1}: ${line}`);
  }
});
