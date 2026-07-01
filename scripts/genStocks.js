const fs = require('fs');
const path = require('path');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nseEqUniverse.json'), 'utf8'));
const symbols = data.map(s => s.symbol);
const tsContent = 'export const AVAILABLE_STOCKS = ' + JSON.stringify(symbols) + ';';
const outDir = path.join(__dirname, '../../frontend/src/constants');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, {recursive: true});
}
fs.writeFileSync(path.join(outDir, 'stocks.ts'), tsContent);
console.log("Created stocks.ts");
