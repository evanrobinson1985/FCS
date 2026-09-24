// Zero-dependency smoke test for whether Passenger can spawn ANYTHING at all
// on this server. If Passenger can't even run this, the problem is
// conclusively in Plesk/Passenger's infrastructure - not in server.js, not
// in any dependency, not in any version of this app's code, ever.
//
// To use: in Plesk's Node.js panel, temporarily change "Application Startup
// File" from server.js to scripts/hello-world-check.js, click Restart App,
// then visit the site. Change it back to server.js when done testing.
const http = require("http");
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hello from a trivial zero-dependency Node server. If you can see this, Passenger CAN spawn a process here.\n");
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`Trivial hello-world server listening on port ${port}`);
  });
