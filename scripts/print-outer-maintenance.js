// Diagnostic: prints the full content of the stale outer maintenance.html
// (app root, sibling to server.js) - suspected to be the original page
// with the caver mini-game already wired in, before it got replaced by a
// simpler version during the httpdocs/ restructuring. Read-only.
const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", "maintenance.html");
if (!fs.existsSync(p)) {
  console.log(`${p} does not exist.`);
  process.exit(0);
}
console.log(`=== ${p} ===`);
console.log(fs.readFileSync(p, "utf8"));
