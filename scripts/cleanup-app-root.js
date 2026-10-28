// One-off cleanup: removes stale files/directories sitting directly in the
// app root (sibling to server.js) that predate this repo's httpdocs/
// reorganization and are now fully superseded by what's properly
// git-tracked inside httpdocs/. See list-app-root.js / check-outer-index.js
// / list-legacy-dirs.js for how these were identified.
//
// Deliberately does NOT touch data.zip (a manual user backup) or anything
// else in the app root - only this exact, hand-verified list.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

const targets = [
  "index.html", // stale duplicate - current one lives in httpdocs/
  "maintenance.html", // stale duplicate - current one lives in httpdocs/
  "styles.css", // stale duplicate - current one lives in httpdocs/
  "favicon.ico", // stale duplicate - current one lives in httpdocs/
  "fcs-logo.png", // stale duplicate - current one lives in httpdocs/
  "bg-far.png", // stale duplicate - now properly in httpdocs/assets/
  "assets", // legacy game-asset dir - now properly in httpdocs/assets/
  "css", // legacy game-css dir - now properly in httpdocs/css/
  "js", // legacy game-js dir - now properly in httpdocs/js/
  "cave-pictures", // empty leftover - the real one is httpdocs/cave-pictures/
];

for (const name of targets) {
  const full = path.join(root, name);
  if (!fs.existsSync(full)) {
    console.log(`SKIP  ${name} (does not exist)`);
    continue;
  }
  const stat = fs.statSync(full);
  fs.rmSync(full, { recursive: true, force: true });
  console.log(`${stat.isDirectory() ? "REMOVED DIR " : "REMOVED FILE"} ${name}`);
}

console.log("\nDone. data.zip and everything else in the app root was left untouched.");
