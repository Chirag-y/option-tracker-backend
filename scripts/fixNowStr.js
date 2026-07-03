const fs = require('fs');
let code = fs.readFileSync('backend/services/scannerEngine.js', 'utf8');

// Replace the hardcoded today string with the date of the last available candle
code = code.replace(/const nowStr = new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\];/g, 'const nowStr = trackerRes[trackerRes.length - 1].date.split("T")[0];');

fs.writeFileSync('backend/services/scannerEngine.js', code);
console.log('Fixed dates in scannerEngine.js!');
