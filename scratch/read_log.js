const fs = require("fs");
const path = require("path");

const logPath = path.join(__dirname, "../error.log");
if (fs.existsSync(logPath)) {
  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n");
  console.log("Last 40 lines of error.log:");
  console.log(lines.slice(-40).join("\n"));
} else {
  console.log("error.log does not exist");
}
