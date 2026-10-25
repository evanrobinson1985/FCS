// SECURITY FIX: moves every sensitive data directory out of the app root
// (which Apache serves directly as static files - see the comments on
// DATA_DIR/NARRATIVE_DIR/CAVE_MAPS_DIR/CAVE_PICTURES_DIR/submissionsFile in
// server.js) into a destination that sits OUTSIDE Apache's DocumentRoot.
//
// Apache's DocumentRoot on this host is the app root itself, and Apache
// serves any file that physically exists there directly, without ever
// invoking Passenger/Node - which means the old locations (data/,
// narratives/, cave-maps/, httpdocs/cave-pictures/, pending-submissions.json)
// bypass every bit of auth in server.js entirely. Moving the real files to a
// directory Apache's DocumentRoot doesn't cover closes that hole with zero
// code changes, because server.js already reads all five of these from
// DATA_DIR/NARRATIVE_DIR/CAVE_MAPS_DIR/CAVE_PICTURES_DIR/SUBMISSIONS_FILE env
// vars (see the top of server.js and around the cave-maps/narratives/
// cave-pictures sections) and falls back to the in-app-root path only when
// the env var isn't set.
//
// Usage (after setting the matching env vars in Plesk's Node.js panel -
// DATA_DIR, NARRATIVE_DIR, CAVE_MAPS_DIR, CAVE_PICTURES_DIR,
// SUBMISSIONS_FILE - to paths under the same base directory):
//   PRIVATE_BASE=/absolute/path/outside/httpdocs npm run relocate-private-data
//
// Safe to re-run: anything already moved (destination exists, source
// doesn't) is skipped rather than re-attempted.
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..");

const base = process.env.PRIVATE_BASE || process.argv[2];
if (!base) {
  console.error("Usage: PRIVATE_BASE=/absolute/path npm run relocate-private-data");
  console.error("(or: node scripts/relocate-private-data.js /absolute/path)");
  process.exit(1);
}
const PRIVATE_BASE = path.resolve(base);

if (PRIVATE_BASE === APP_ROOT || PRIVATE_BASE.startsWith(APP_ROOT + path.sep)) {
  console.error(
    `Refusing to run: PRIVATE_BASE (${PRIVATE_BASE}) is inside the app root (${APP_ROOT}).`
  );
  console.error(
    "That defeats the whole point - it has to be a directory Apache's DocumentRoot does not cover."
  );
  process.exit(1);
}

// Hardcoded, explicit source -> destination list. Mirrors exactly what
// DATA_DIR/NARRATIVE_DIR/CAVE_MAPS_DIR/CAVE_PICTURES_DIR/SUBMISSIONS_FILE
// default to in server.js today.
const moves = [
  { label: "DATA_DIR", from: path.join(APP_ROOT, "data"), to: path.join(PRIVATE_BASE, "data") },
  { label: "NARRATIVE_DIR", from: path.join(APP_ROOT, "narratives"), to: path.join(PRIVATE_BASE, "narratives") },
  { label: "CAVE_MAPS_DIR", from: path.join(APP_ROOT, "cave-maps"), to: path.join(PRIVATE_BASE, "cave-maps") },
  { label: "CAVE_PICTURES_DIR", from: path.join(APP_ROOT, "httpdocs", "cave-pictures"), to: path.join(PRIVATE_BASE, "cave-pictures") },
  { label: "SUBMISSIONS_FILE", from: path.join(APP_ROOT, "pending-submissions.json"), to: path.join(PRIVATE_BASE, "pending-submissions.json") },
];

fs.mkdirSync(PRIVATE_BASE, { recursive: true });

function moveOne({ label, from, to }) {
  if (!fs.existsSync(from)) {
    if (fs.existsSync(to)) {
      console.log(`[${label}] already moved: ${from} doesn't exist, ${to} does. Skipping.`);
    } else {
      console.log(`[${label}] nothing to move: ${from} doesn't exist (never created yet). Skipping.`);
    }
    return;
  }
  if (fs.existsSync(to)) {
    console.error(
      `[${label}] ABORTING this item: both ${from} and ${to} exist. Not overwriting - resolve manually.`
    );
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code === "EXDEV") {
      // Cross-filesystem move - rename can't do this atomically, fall back
      // to copy-then-delete.
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
  console.log(`[${label}] moved ${from} -> ${to}`);
}

console.log(`Relocating private data to: ${PRIVATE_BASE}\n`);
for (const m of moves) moveOne(m);

console.log(`\nDone. Now set these env vars in Plesk's Node.js panel (if not already set) and restart the app:`);
console.log(`  DATA_DIR=${path.join(PRIVATE_BASE, "data")}`);
console.log(`  NARRATIVE_DIR=${path.join(PRIVATE_BASE, "narratives")}`);
console.log(`  CAVE_MAPS_DIR=${path.join(PRIVATE_BASE, "cave-maps")}`);
console.log(`  CAVE_PICTURES_DIR=${path.join(PRIVATE_BASE, "cave-pictures")}`);
console.log(`  SUBMISSIONS_FILE=${path.join(PRIVATE_BASE, "pending-submissions.json")}`);
