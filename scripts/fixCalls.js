const fs = require('fs');
let c = fs.readFileSync('services/scannerEngine.js', 'utf8');
c = c.replace(/calculateStrengthScore\(metrics\)/g, (match, offset) => {
    let pre = c.substring(0, offset);
    if (pre.lastIndexOf('"fo-bearish"') > pre.lastIndexOf('case "fo-bullish"')) return 'calculateStrengthScore(metrics, "BEARISH")';
    if (pre.lastIndexOf('"intraday-bearish"') > pre.lastIndexOf('case "intraday-bullish"')) return 'calculateStrengthScore(metrics, "BEARISH")';
    return 'calculateStrengthScore(metrics, "BULLISH")';
});
fs.writeFileSync('services/scannerEngine.js', c);
console.log('Fixed scannerEngine.js calls');
