// One-off tool to flip maintenanceMode directly in data/site-config.json -
// the exact same file the Website Management tab's "Maintenance Mode"
// toggle reads and writes, so switching it back later via a normal login
// works exactly as usual, no extra step needed.
//
// Usage:
//   npm run set-maintenance                               (turns maintenance mode ON)
//   npm run set-maintenance -- off                         (turns maintenance mode OFF)
//   npm run set-maintenance -- --data-dir=/path            (ON, explicit data dir)
//   npm run set-maintenance -- off --data-dir=/path        (OFF, explicit data dir)
//
// NOTE: Plesk's "Run Node.js commands" tool does NOT inherit the custom
// environment variables configured in the Node.js panel, so if DATA_DIR has
// been relocated outside the app root (see scripts/relocate-private-data.js),
// running this with no override silently writes to the OLD in-app-root
// default instead of the real site-config.json the running app reads.
const fs = require("fs");
const path = require("path");

const rawArgs = process.argv.slice(2);
const dataDirFlag = rawArgs.find((a) => a.startsWith("--data-dir="));
const positional = rawArgs.filter((a) => !a.startsWith("--data-dir="));

const DATA_DIR = dataDirFlag
  ? path.resolve(dataDirFlag.slice("--data-dir=".length))
  : process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const SITE_CONFIG_FILE = path.join(DATA_DIR, "site-config.json");

const enabled = positional[0] !== "off";

let config = {};
if (fs.existsSync(SITE_CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(SITE_CONFIG_FILE, "utf8"));
}
config.maintenanceMode = enabled;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(SITE_CONFIG_FILE, JSON.stringify(config, null, 2));
console.log(`maintenanceMode set to ${enabled}. Wrote ${SITE_CONFIG_FILE}`);
