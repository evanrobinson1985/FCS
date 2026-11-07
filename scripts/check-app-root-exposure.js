// Read-only check: does any sensitive data currently sit directly under the
// app root, where Apache's DocumentRoot serves it as a static file without
// ever going through Node/Passenger (and therefore without ever hitting
// authenticateToken)?
//
// Run this BEFORE scripts/relocate-private-data.js to see what's currently
// exposed, and again AFTER to confirm the app root is clean. Reports only
// DATA_DIR/NARRATIVE_DIR/CAVE_MAPS_DIR/CAVE_PICTURES_DIR/SUBMISSIONS_FILE's
// in-app-root default locations, not wherever the env vars currently point -
// a clean report here means there's nothing left for Apache to serve
// directly, regardless of how the app is actually configured right now.
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..");

const checks = [
  { label: "DATA_DIR default (data/)", target: path.join(APP_ROOT, "data") },
  { label: "NARRATIVE_DIR default (narratives/)", target: path.join(APP_ROOT, "narratives") },
  { label: "CAVE_MAPS_DIR default (cave-maps/)", target: path.join(APP_ROOT, "cave-maps") },
  { label: "CAVE_PICTURES_DIR default (httpdocs/cave-pictures/)", target: path.join(APP_ROOT, "httpdocs", "cave-pictures") },
  { label: "SUBMISSIONS_FILE default (pending-submissions.json)", target: path.join(APP_ROOT, "pending-submissions.json") },
  { label: "git metadata (.git/)", target: path.join(APP_ROOT, ".git") },
];

console.log(`Checking app root: ${APP_ROOT}\n`);
let anyExposed = false;
for (const { label, target } of checks) {
  if (!fs.existsSync(target)) {
    console.log(`OK    ${label} - does not exist here, nothing for Apache to serve.`);
    continue;
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const count = countFiles(target);
    console.log(`EXPOSED  ${label} - EXISTS as a directory with ${count} file(s) under it.`);
  } else {
    console.log(`EXPOSED  ${label} - EXISTS as a file (${stat.size} bytes).`);
  }
  anyExposed = true;
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
}

console.log("");
if (anyExposed) {
  console.log(
    "At least one sensitive path is sitting directly in the app root. On this host, Apache's\n" +
      "DocumentRoot IS the app root, so these are directly fetchable over HTTP(S) with no\n" +
      "authentication at all, regardless of what server.js's routes do. Run:\n" +
      "  PRIVATE_BASE=/absolute/path/outside/httpdocs npm run relocate-private-data\n" +
      "then set the matching DATA_DIR/NARRATIVE_DIR/CAVE_MAPS_DIR/CAVE_PICTURES_DIR/SUBMISSIONS_FILE\n" +
      "env vars in Plesk's Node.js panel and restart the app."
  );
  process.exitCode = 1;
} else {
  console.log("Clean - nothing sensitive sits directly in the app root right now.");
}
