const fs = require("fs");
const { symbolToTokenMap } = require("../services/marketDataFeed");

console.log("Nifty 50 instrument mapping:", symbolToTokenMap["Nifty 50"]);
console.log("Nifty Bank instrument mapping:", symbolToTokenMap["Nifty Bank"]);
console.log("SENSEX instrument mapping:", symbolToTokenMap["SENSEX"]);
