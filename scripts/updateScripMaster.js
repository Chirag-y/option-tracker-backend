const https = require('https');
const fs = require('fs');
const path = require('path');

const url = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
const dest = path.join(__dirname, "../config/scripMaster.json");

console.log("Downloading scripMaster.json...");
const file = fs.createWriteStream(dest);

https.get(url, function(response) {
  response.pipe(file);
  file.on('finish', function() {
    file.close(() => {
      console.log("Download completed successfully.");
    });
  });
}).on('error', function(err) {
  fs.unlink(dest, () => {});
  console.error("Error downloading file:", err.message);
});
