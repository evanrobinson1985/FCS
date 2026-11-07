// Diagnostic: checks whether a stale, standalone index.html exists in the
// app root (sibling to server.js) - separate from the git-tracked one
// inside httpdocs/, which is what server.js's own "/" route actually
// serves. If Apache statically serves this outer file directly (bypassing
// Passenger/our Express app entirely) whenever it exists, that would
// explain why maintenance mode - a server-side check - never takes effect
// for "/" no matter what data/site-config.json says.
const fs = require("fs");
const path = require("path");

const outerPath = path.join(__dirname, "..", "index.html");
const innerPath = path.join(__dirname, "..", "httpdocs", "index.html");

function describe(label, p) {
  if (!fs.existsSync(p)) {
    console.log(`${label}: does not exist (${p})`);
    return;
  }
  const stat = fs.statSync(p);
  const content = fs.readFileSync(p, "utf8");
  const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
  console.log(
    `${label}: EXISTS (${p})\n  size=${stat.size} bytes, mtime=${stat.mtime.toISOString()}\n  <title>: ${titleMatch ? titleMatch[1] : "(none found)"}\n  contains "Under Construction": ${content.includes("Under Construction")}\n  contains "Login to Florida Cave Survey": ${content.includes("Login to Florida Cave Survey")}`
  );
}

describe("OUTER (app root)", outerPath);
console.log("");
describe("INNER (httpdocs/, git-tracked)", innerPath);
