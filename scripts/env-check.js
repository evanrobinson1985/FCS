// Diagnostic: reports which environment variables are actually visible to
// a process Passenger spawns, without ever revealing the real secret value.
// server.js exits immediately if JWT_SECRET is missing/too short - if
// Passenger's specific spawn mechanism doesn't inject the custom env vars
// configured in the Node.js panel the same way other execution paths on
// this server do, that alone would explain every spawn failure we've seen.
//
// To use: temporarily set "Application Startup File" to this file in
// Plesk's Node.js panel, Restart App, then visit a non-static URL (e.g.
// /api/site-status) - Apache serves index.html directly for "/" regardless
// of whether Passenger is working, so that path doesn't test anything.
const http = require("http");
const port = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    const info = {
      JWT_SECRET_present: !!process.env.JWT_SECRET,
      JWT_SECRET_length: process.env.JWT_SECRET ? process.env.JWT_SECRET.length : 0,
      NODE_ENV: process.env.NODE_ENV || "(not set)",
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || "(not set)",
      PORT: process.env.PORT || "(not set, defaulted to 3000)",
      PWD: process.env.PWD || process.cwd(),
      NODE_VERSION: process.version,
      totalEnvVarCount: Object.keys(process.env).length,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(info, null, 2));
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`env-check server listening on port ${port}`);
  });
