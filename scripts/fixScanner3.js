const fs = require('fs');
const lines = fs.readFileSync('backend/controllers/scannerController.js', 'utf8').split('\n');

// 1. Keep lines 0 to 534 (which is indices 0 to 534)
const goodPart1 = lines.slice(0, 535);

// 2. We see fetchCustomOptionsHistorical is at line 910. 
// We should check where it actually starts. Let's find 'exports.fetchCustomOptionsHistorical'
const customOptionsStart = lines.findIndex(l => l.includes('exports.fetchCustomOptionsHistorical'));

if (customOptionsStart !== -1) {
    const goodPart2 = lines.slice(customOptionsStart);
    const result = goodPart1.concat(goodPart2).join('\n');
    fs.writeFileSync('backend/controllers/scannerController.js', result);
    console.log('Fixed file! Kept lines up to 534 and from', customOptionsStart, 'to end.');
} else {
    console.log('Could not find fetchCustomOptionsHistorical');
}
