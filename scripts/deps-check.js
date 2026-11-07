// Diagnostic: requires the exact same dependencies server.js does, skips
// all data loading and route setup, and reports how long each require()
// took. Isolates "is Passenger's spawn environment just slow/resource-
// constrained for loading this app's dependency tree" from "is it
// something about the data loading or route setup specifically."
const t0 = Date.now();
const timings = {};

function timedRequire(name, mod) {
  const start = Date.now();
  const result = require(mod);
  timings[name] = Date.now() - start;
  return result;
}

timedRequire("dotenv", "dotenv");
require("dotenv").config();
const express = timedRequire("express", "express");
timedRequire("fs", "fs");
timedRequire("path", "path");
timedRequire("crypto", "crypto");
timedRequire("helmet", "helmet");
timedRequire("cors", "cors");
timedRequire("express-rate-limit", "express-rate-limit");
timedRequire("sanitize-html", "sanitize-html");
timedRequire("nodemailer", "nodemailer");
timedRequire("multer", "multer");
timedRequire("jsonwebtoken", "jsonwebtoken");
timedRequire("bcryptjs", "bcryptjs");
timedRequire("xlsx", "xlsx");

let betterSqlite3Status = "not attempted";
try {
  const start = Date.now();
  require("better-sqlite3");
  timings["better-sqlite3"] = Date.now() - start;
  betterSqlite3Status = "loaded";
} catch (err) {
  betterSqlite3Status = "not installed (expected/optional): " + err.message;
}

const totalRequireTime = Date.now() - t0;

const app = express();
const port = process.env.PORT || 3000;

app.use((req, res) => {
  res.json({
    totalRequireTimeMs: totalRequireTime,
    perModuleMs: timings,
    betterSqlite3Status,
    processUptimeAtRequestSec: process.uptime(),
    memoryUsage: process.memoryUsage(),
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`deps-check server listening on port ${port}, total require time: ${totalRequireTime}ms`);
});
