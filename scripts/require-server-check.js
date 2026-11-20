// Diagnostic: requires the REAL, completely unmodified server.js (it
// already exports its app for the test suite - see the require.main guard
// at the bottom of that file) and times exactly how long that takes under
// Passenger, then serves the real app directly. Every individual piece of
// server.js's startup has been confirmed fast in isolation (deps-check.js,
// full-init-check.js, middleware-check.js) - this is the one remaining
// test: does registering all ~100 real routes, on top of everything else,
// combined in the one real file, succeed and how long does it take.
const t0 = Date.now();
let app;
let requireError = null;

try {
  app = require("../server.js");
} catch (err) {
  requireError = { message: err.message, stack: err.stack };
}
const requireMs = Date.now() - t0;
const port = process.env.PORT || 3000;

if (!app) {
  const express = require("express");
  const fallback = express();
  fallback.use((req, res) => {
    res.status(500).json({ requireSucceeded: false, requireMs, requireError });
  });
  fallback.listen(port, "0.0.0.0", () => {
    console.log(`require-server-check: require of ../server.js FAILED after ${requireMs}ms - ${requireError.message}`);
  });
} else {
  console.log(`require-server-check: require of ../server.js succeeded after ${requireMs}ms, now listening via wrapper`);
  app.listen(port, "0.0.0.0", () => {
    console.log(`require-server-check: real app listening on port ${port}, requireMs=${requireMs}`);
  });
}
