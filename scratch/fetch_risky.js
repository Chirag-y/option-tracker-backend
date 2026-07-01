const http = require("http");

http.get("http://localhost:5000/api/scanner/nifty-signals/backtest", (res) => {
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    try {
      const json = JSON.parse(data);
      console.log("Success:", json.success);
      const trades = json.trades || [];
      const riskyTrades = trades.filter(t => t.signalStrength === "RISKY");
      const closedAt315 = trades.filter(t => t.type.includes("3:15 PM CLOSE"));
      console.log("Total trades:", trades.length);
      console.log("Risky trades count:", riskyTrades.length);
      console.log("3:15 PM Close trades count:", closedAt315.length);
      if (riskyTrades.length > 0) {
        console.log("Sample Risky Trade:", riskyTrades[0]);
      }
      if (closedAt315.length > 0) {
        console.log("Sample 3:15 PM Closed Trade:", closedAt315[0]);
      }
    } catch (e) {
      console.error("Parse error:", e.message);
    }
  });
}).on("error", (err) => {
  console.error("HTTP error:", err.message);
});
