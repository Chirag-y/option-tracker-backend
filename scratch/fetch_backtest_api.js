const http = require("http");

http.get("http://localhost:5000/api/scanner/nifty-signals/backtest", (res) => {
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    try {
      const json = JSON.parse(data);
      console.log("Success:", json.success);
      if (json.trades && json.trades.length > 0) {
        console.log("First trade in API response:", json.trades[0]);
      } else {
        console.log("No trades returned or structure different:", Object.keys(json));
      }
    } catch (e) {
      console.error("Parse error:", e.message);
      console.log("Raw response:", data.slice(0, 500));
    }
  });
}).on("error", (err) => {
  console.error("HTTP error:", err.message);
});
