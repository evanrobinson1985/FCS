// Companion to start-background.js: reports whether the detached process
// is still alive, tails its log, and does a self-check HTTP request against
// its own port. Run via: npm run bg-status
const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const LOG_FILE = path.join(ROOT, "tmp", "bg-server.log");
const PID_FILE = path.join(ROOT, "tmp", "bg-server.pid");

if (!fs.existsSync(PID_FILE)) {
  console.log("No pidfile found - start-background.js hasn't been run (or stop-background.js already cleaned up).");
  process.exit(0);
}

const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
let alive = false;
try {
  process.kill(pid, 0);
  alive = true;
} catch (_) {
  alive = false;
}
console.log(`PID ${pid}: ${alive ? "ALIVE" : "not running"}`);

if (fs.existsSync(LOG_FILE)) {
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
  console.log(`--- last 40 lines of ${LOG_FILE} ---`);
  console.log(lines.slice(-40).join("\n"));
} else {
  console.log("No log file yet.");
}

if (alive) {
  const port = process.env.PORT || 3000;
  http
    .get(`http://127.0.0.1:${port}/api/site-status`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        console.log(`Self-check GET 127.0.0.1:${port}/api/site-status -> ${res.statusCode}: ${body.slice(0, 300)}`);
      });
    })
    .on("error", (err) => {
      console.log(`Self-check request failed: ${err.message}`);
    });
}
