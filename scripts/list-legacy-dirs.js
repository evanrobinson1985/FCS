// Diagnostic: lists the actual file names inside the legacy outer
// assets/, css/, js/, and cave-pictures/ directories (found via
// list-app-root.js), so we know exactly what's there before proposing to
// delete anything. Read-only.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
for (const dir of ["assets", "css", "js", "cave-pictures"]) {
  const full = path.join(root, dir);
  console.log(`--- ${dir}/ ---`);
  if (!fs.existsSync(full)) {
    console.log("  (does not exist)");
    continue;
  }
  const entries = fs.readdirSync(full);
  if (entries.length === 0) {
    console.log("  (empty)");
  } else {
    for (const e of entries) {
      const stat = fs.statSync(path.join(full, e));
      console.log(`  ${e}${stat.isDirectory() ? "/" : ""} (${stat.size} bytes)`);
    }
  }
}
