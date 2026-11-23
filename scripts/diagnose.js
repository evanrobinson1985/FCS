#!/usr/bin/env node
// One-off diagnostic: boots this app in-process, against this deployment's
// real data files, on a random local port (never the real PORT, so it can't
// collide with whatever's already running), hits a couple of key routes
// over a real HTTP request, and prints exactly what each one returned -
// including the full error if something throws. Uses only Node's own
// built-in fetch (no dependency), so it works even where devDependencies
// weren't installed (NODE_ENV=production commonly skips them).
//
// Usage: node scripts/diagnose.js
// (or, from Plesk's "Run Node.js commands" tool with "npm" selected:
//  type "run diagnose" - see the "diagnose" script in package.json)

const app = require("../server");

const server = app.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`Diagnostic server listening on ${base}\n`);

  async function check(label, path, init) {
    console.log(`=== ${label} ${path} ===`);
    try {
      const res = await fetch(base + path, init);
      const text = await res.text();
      console.log("status:", res.status);
      console.log("body:", text.slice(0, 2000));
    } catch (e) {
      console.log("THREW:", e.stack || e.message);
    }
    console.log("");
  }

  await check("GET", "/api/site-status");
  await check("POST", "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "diagnostic-nonexistent-user", password: "whatever12345" }),
  });

  server.close(() => process.exit(0));
});

server.on("error", (err) => {
  console.log("Server failed to start:", err.stack || err.message);
  process.exit(1);
});
