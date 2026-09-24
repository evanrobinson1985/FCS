// Undoes write-htaccess.js. Run via: npm run remove-proxy
const path = require("path");
const fs = require("fs");

const HTACCESS_PATH = path.join(__dirname, "..", ".htaccess");
// Also clean up the wrong location an earlier version of write-htaccess.js
// used (the app's own httpdocs/ subfolder, not the app root) - harmless if
// it was never created.
const STALE_HTACCESS_PATH = path.join(__dirname, "..", "httpdocs", ".htaccess");

for (const p of [HTACCESS_PATH, STALE_HTACCESS_PATH]) {
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log(`Removed ${p}.`);
  } else {
    console.log(`${p} doesn't exist - nothing to remove there.`);
  }
}
