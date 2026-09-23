// Undoes write-htaccess.js. Run via: npm run remove-proxy
const path = require("path");
const fs = require("fs");

const HTACCESS_PATH = path.join(__dirname, "..", "httpdocs", ".htaccess");

if (fs.existsSync(HTACCESS_PATH)) {
  fs.unlinkSync(HTACCESS_PATH);
  console.log(`Removed ${HTACCESS_PATH}.`);
} else {
  console.log(`${HTACCESS_PATH} doesn't exist - nothing to remove.`);
}
