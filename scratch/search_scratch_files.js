const fs = require("fs");
const path = require("path");

const planPath = "C:\\Users\\Chirag\\.gemini\\antigravity\\brain\\2e5b34b5-2198-44c9-92f0-5f8eb074ff20\\implementation_plan.md";
if (fs.existsSync(planPath)) {
  const content = fs.readFileSync(planPath, "utf-8");
  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    if (line.includes("200-250") || line.includes("500-650") || line.includes("550-700") || line.includes("premium")) {
      console.log(`Plan Line ${idx + 1}: ${line}`);
    }
  });
} else {
  console.log("Plan file not found");
}
