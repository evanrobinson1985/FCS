#!/usr/bin/env node
// Bootstraps or updates a user account directly in data/users.json.
//
// The app's own signup flow (/api/create-account) always creates a
// "pending" member account and can't grant the webmaster role, so there's
// no way to create the first webmaster account - or reset anyone's
// password/role from the command line - through the app itself. This is
// that escape hatch, meant to be run directly on the server, not exposed
// over HTTP.
//
// Usage:
//   node scripts/create-user.js <username> <password> <role> <email> [fullName]
//
//   role   - member | admin | webmaster
//   email  - required (used for password-reset and 2FA emails)
//
// Respects DATA_DIR the same way server.js does, so this targets the same
// data/ directory the running server reads from. Running it again for the
// same username updates that account in place (new password/role/email)
// rather than creating a duplicate.

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const [, , username, password, role, email, fullName] = process.argv;

if (!username || !password || !role || !email) {
  console.error(
    "Usage: node scripts/create-user.js <username> <password> <role: member|admin|webmaster> <email> [fullName]"
  );
  process.exit(1);
}

const VALID_ROLES = ["member", "admin", "webmaster"];
if (!VALID_ROLES.includes(role)) {
  console.error(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(", ")}.`);
  process.exit(1);
}

const MIN_PASSWORD_LENGTH = 10; // must match server.js
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

let users = [];
if (fs.existsSync(USERS_FILE)) {
  users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

(async () => {
  const passwordHash = await bcrypt.hash(password, 12);
  const existingIndex = users.findIndex((u) => u.username === username);
  const existing = existingIndex >= 0 ? users[existingIndex] : null;

  const userRecord = {
    id: existing ? existing.id : `${role}-${Date.now()}`,
    username,
    email,
    passwordHash,
    fullName: fullName || existing?.fullName || username,
    nssNumber: existing?.nssNumber || "",
    role,
    status: "active",
    created: existing ? existing.created : new Date().toISOString(),
    lastLogin: existing ? existing.lastLogin : null,
    loginAttempts: 0,
    lastFailedLogin: null,
    isEmailVerified: true,
    twoFactorEnabled: existing ? !!existing.twoFactorEnabled : false,
    loginIPs: existing?.loginIPs || [],
  };

  if (existing) {
    users[existingIndex] = userRecord;
    console.log(`Updated existing user "${username}" (role: ${role}, status: active).`);
  } else {
    users.push(userRecord);
    console.log(`Created new user "${username}" (role: ${role}, status: active).`);
  }

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  console.log(`Written to ${USERS_FILE}`);
  console.log(
    `They can log in with this password now, and change it themselves afterward from ` +
      `the dashboard header ("Change Password") once logged in.`
  );
})();
