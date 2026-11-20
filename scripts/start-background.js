// Experimental: starts server.js as a detached background process, outside
// Passenger entirely, for use only where Passenger itself can't spawn the
// app (see the live-deployment troubleshooting this was written for). Not
// part of the normal deployment path - Plesk's Node.js panel is still how
// this app is meant to run day to day.
//
// Run via: npm run start-bg
// Check on it: npm run bg-status
// Stop it: npm run stop-bg
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const TMP_DIR = path.join(ROOT, "tmp");
const LOG_FILE = path.join(TMP_DIR, "bg-server.log");
const PID_FILE = path.join(TMP_DIR, "bg-server.pid");

fs.mkdirSync(TMP_DIR, { recursive: true });

if (fs.existsSync(PID_FILE)) {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  if (existingPid) {
    try {
      process.kill(existingPid, 0);
      console.log(`Already running as PID ${existingPid} (per ${PID_FILE}).`);
      console.log(`Run "npm run stop-bg" first if you want to restart it.`);
      process.exit(0);
    } catch (_) {
      // Stale pidfile - that process is gone, fall through and start fresh.
    }
  }
}

const logFd = fs.openSync(LOG_FILE, "a");
const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", logFd, logFd],
  env: process.env,
});
child.unref();
fs.writeFileSync(PID_FILE, String(child.pid));

console.log(`Spawned detached server, PID ${child.pid}. Logging to ${LOG_FILE}.`);
console.log(`This script's own process exiting now is expected - the child is unref()'d and detached.`);
console.log(`Wait a few seconds, then run "npm run bg-status" to check whether the child survived.`);
