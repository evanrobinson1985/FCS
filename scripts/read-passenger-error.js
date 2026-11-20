// One-off diagnostic: prints the most recent Phusion Passenger spawn-error
// report (the HTML files Passenger saves to /tmp/passenger-error-*.html
// whenever it fails to start or the app process dies). Run via:
//   npm run read-passenger-error
// Safe to remove once the live deployment issue is resolved.
const fs = require("fs");
const path = require("path");

const dir = "/tmp";
const files = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith("passenger-error-") && f.endsWith(".html"));

if (files.length === 0) {
  console.log("No passenger-error-*.html files found in /tmp");
  process.exit(0);
}

files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);

const latest = files[0];
console.log(`=== Latest: ${latest} (${files.length} total) ===\n`);
console.log(fs.readFileSync(path.join(dir, latest), "utf8"));
