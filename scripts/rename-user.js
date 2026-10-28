// Renames an existing account's username in place, leaving everything else
// (passwordHash, role, email, id, etc.) untouched. The app has no
// self-service "change username" feature - only change-password,
// change-user-role, change-user-states, toggle-user-status - so this is the
// escape hatch, same pattern as scripts/create-user.js.
//
// Usage:
//   node scripts/rename-user.js <oldUsername> <newUsername> [--data-dir=/path]
//
// NOTE: Plesk's "Run Node.js commands" tool does NOT inherit the custom
// environment variables configured in the Node.js panel - pass --data-dir
// explicitly rather than relying on DATA_DIR there. See
// scripts/relocate-private-data.js for where the real data directory is.
const fs = require("fs");
const path = require("path");

const rawArgs = process.argv.slice(2);
const dataDirFlag = rawArgs.find((a) => a.startsWith("--data-dir="));
const positional = rawArgs.filter((a) => !a.startsWith("--data-dir="));
const [oldUsername, newUsername] = positional;

if (!oldUsername || !newUsername) {
  console.error("Usage: node scripts/rename-user.js <oldUsername> <newUsername> [--data-dir=/path]");
  process.exit(1);
}

const DATA_DIR = dataDirFlag
  ? path.resolve(dataDirFlag.slice("--data-dir=".length))
  : process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(USERS_FILE)) {
  console.error(`No users file at ${USERS_FILE}`);
  process.exit(1);
}

const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

const target = users.find((u) => u.username === oldUsername);
if (!target) {
  console.error(`No account with username "${oldUsername}" found.`);
  process.exit(1);
}

if (users.some((u) => u.username === newUsername)) {
  console.error(`An account with username "${newUsername}" already exists - aborting without changing anything.`);
  process.exit(1);
}

target.username = newUsername;
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
console.log(`Renamed "${oldUsername}" -> "${newUsername}" (password, role, and everything else unchanged).`);
console.log(`Written to ${USERS_FILE}`);
