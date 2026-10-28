// Stops the process started by start-background.js. Run via: npm run stop-bg
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const PID_FILE = path.join(ROOT, "tmp", "bg-server.pid");

if (!fs.existsSync(PID_FILE)) {
  console.log("No pidfile found - nothing to stop.");
  process.exit(0);
}

const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
try {
  process.kill(pid, "SIGTERM");
  console.log(`Sent SIGTERM to PID ${pid}.`);
} catch (err) {
  console.log(`Could not signal PID ${pid}: ${err.message}`);
}
fs.unlinkSync(PID_FILE);
