// Read-only: lists the directory ONE LEVEL ABOVE the app root (i.e. the
// vhost root, since Plesk's own "httpdocs" convention happens to be the app
// root's name too - see scripts/relocate-private-data.js). Looking for an
// existing sibling directory (Plesk sometimes provisions one, e.g.
// "private") that sits outside Apache's DocumentRoot and can be used as
// PRIVATE_BASE. Also does a harmless write+delete test to confirm the app's
// OS user actually has permission to create files there.
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..");
const VHOST_ROOT = path.join(APP_ROOT, "..");

console.log(`App root:   ${APP_ROOT}`);
console.log(`Vhost root: ${VHOST_ROOT}\n`);

let entries;
try {
  entries = fs.readdirSync(VHOST_ROOT, { withFileTypes: true });
} catch (err) {
  console.error(`Could not list ${VHOST_ROOT}: ${err.message}`);
  console.error("The app's OS user likely can't see above its own app root. You'll need to");
  console.error("create a directory via Plesk's File Manager instead - see the README output below.");
  process.exit(1);
}

console.log("Contents of vhost root:");
for (const e of entries) {
  console.log(`  ${e.isDirectory() ? "[dir] " : "[file]"} ${e.name}`);
}

const probe = path.join(VHOST_ROOT, `.write-test-${Date.now()}.tmp`);
try {
  fs.writeFileSync(probe, "test");
  fs.unlinkSync(probe);
  console.log(`\nWrite test: OK - the app can create files directly in ${VHOST_ROOT}.`);
  console.log(`A good PRIVATE_BASE candidate: ${path.join(VHOST_ROOT, "private")}`);
} catch (err) {
  console.log(`\nWrite test: FAILED (${err.message})`);
  console.log("The app's OS user can't write here. You'll need to create the private directory");
  console.log("yourself via Plesk's File Manager (browse to the vhost root, one level above");
  console.log("httpdocs/, and create a new folder there), then re-run this check.");
}
