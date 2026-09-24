// One-off tool to flip maintenanceMode directly in data/site-config.json -
// the exact same file the Website Management tab's "Maintenance Mode"
// toggle reads and writes, so switching it back later via a normal login
// works exactly as usual, no extra step needed.
//
// Usage:
//   npm run set-maintenance         (turns maintenance mode ON)
//   npm run set-maintenance -- off  (turns maintenance mode OFF)
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");
const SITE_CONFIG_FILE = path.join(DATA_DIR, "site-config.json");

const enabled = process.argv[2] !== "off";

let config = {};
if (fs.existsSync(SITE_CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(SITE_CONFIG_FILE, "utf8"));
}
config.maintenanceMode = enabled;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(SITE_CONFIG_FILE, JSON.stringify(config, null, 2));
console.log(`maintenanceMode set to ${enabled}. Wrote ${SITE_CONFIG_FILE}`);
