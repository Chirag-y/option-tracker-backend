const fs = require('fs');

let c = fs.readFileSync('services/scannerEngine.js', 'utf8');

c = c.replace(/if \(!isMarketOpen\(\)\) \{\s*const nowStr = new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\];\s*for \(let i = trackerRes\.length - 1; i >= 0; i--\) \{\s*if \(trackerRes\[i\]\.date\.split\("T"\)\[0\] !== nowStr\) break;\s*if \(trackerRes\[i\]\.signal === "LONG"\) \{\s*lastSignal = trackerRes\[i\];\s*triggered = true;\s*break;\s*\} else if \(trackerRes\[i\]\.signal === "SHORT"\) \{\s*break;\s*\}\s*\}\s*\} else \{\s*triggered = lastSignal && lastSignal\.signal === "LONG";\s*\}/g, `
          const nowStr = new Date().toISOString().split("T")[0];
          for (let i = trackerRes.length - 1; i >= 0; i--) {
            if (trackerRes[i].date.split("T")[0] !== nowStr) break;
            if (trackerRes[i].signal === "LONG") {
               lastSignal = trackerRes[i];
               triggered = true;
               break;
            } else if (trackerRes[i].signal === "SHORT") {
               break;
            }
          }
`);

c = c.replace(/if \(!isMarketOpen\(\)\) \{\s*const nowStr = new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\];\s*for \(let i = trackerRes\.length - 1; i >= 0; i--\) \{\s*if \(trackerRes\[i\]\.date\.split\("T"\)\[0\] !== nowStr\) break;\s*if \(trackerRes\[i\]\.signal === "SHORT"\) \{\s*lastSignal = trackerRes\[i\];\s*triggered = true;\s*break;\s*\} else if \(trackerRes\[i\]\.signal === "LONG"\) \{\s*break;\s*\}\s*\}\s*\} else \{\s*triggered = lastSignal && lastSignal\.signal === "SHORT";\s*\}/g, `
          const nowStr = new Date().toISOString().split("T")[0];
          for (let i = trackerRes.length - 1; i >= 0; i--) {
            if (trackerRes[i].date.split("T")[0] !== nowStr) break;
            if (trackerRes[i].signal === "SHORT") {
               lastSignal = trackerRes[i];
               triggered = true;
               break;
            } else if (trackerRes[i].signal === "LONG") {
               break;
            }
          }
`);

fs.writeFileSync('services/scannerEngine.js', c);
console.log('Fixed Live Engine triggers');
