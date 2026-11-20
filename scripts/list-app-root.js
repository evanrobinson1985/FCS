// Diagnostic: lists everything directly in the app root (sibling to
// server.js), to find every stale leftover from before this repo's static
// files were reorganized into their own httpdocs/ subfolder - not just
// index.html. Read-only, deletes nothing.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const entries = fs.readdirSync(root, { withFileTypes: true });

for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  const full = path.join(root, entry.name);
  if (entry.isDirectory()) {
    let fileCount = "?";
    try {
      fileCount = fs.readdirSync(full).length;
    } catch (_) {}
    console.log(`DIR  ${entry.name}/  (${fileCount} entries)`);
  } else {
    const stat = fs.statSync(full);
    console.log(`FILE ${entry.name}  (${stat.size} bytes, mtime=${stat.mtime.toISOString()})`);
  }
}
