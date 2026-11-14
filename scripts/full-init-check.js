// Diagnostic: replicates server.js's full initialization - every directory
// creation and every data file load, in the same order, with the same
// paths - but registers zero real routes. Isolates "does Passenger choke
// on server.js's actual startup work" from "does it choke on registering
// ~100 real routes/middleware." Every step is wrapped so one failure
// doesn't hide the rest - if something throws, we still find out which
// step and why instead of the whole process dying silently.
const t0 = Date.now();
const fs = require("fs");
const path = require("path");
const express = require("express");
const app = express();

const steps = [];
function step(name, fn) {
  const start = Date.now();
  try {
    const result = fn();
    steps.push({ name, ms: Date.now() - start, ok: true, result: result === undefined ? null : result });
  } catch (err) {
    steps.push({ name, ms: Date.now() - start, ok: false, error: err.message, stack: err.stack });
  }
}

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CAVE_DB_FILE = path.join(DATA_DIR, "cave-database.json");
const STATES_CONFIG_FILE = path.join(__dirname, "..", "config", "states.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const caveMapsDir = process.env.CAVE_MAPS_DIR ? path.resolve(process.env.CAVE_MAPS_DIR) : path.join(__dirname, "..", "cave-maps");
const geotiffDir = path.join(caveMapsDir, "geotiff");
const shapefilesDir = path.join(caveMapsDir, "shapefiles");
const caveMapsCollectionDir = path.join(__dirname, "..", "cave-maps", "cavemaps");
const sqliteHillshadesDir = path.join(__dirname, "..", "cave-maps", "sqlite-hillshades");
const NARRATIVE_DIR = process.env.NARRATIVE_DIR ? path.resolve(process.env.NARRATIVE_DIR) : path.join(__dirname, "..", "narratives");
const CAVE_PICTURES_DIR = process.env.CAVE_PICTURES_DIR ? path.resolve(process.env.CAVE_PICTURES_DIR) : path.join(__dirname, "..", "httpdocs", "cave-pictures");

step("mkdir DATA_DIR", () => { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); return DATA_DIR; });
step("mkdir BACKUP_DIR", () => { if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }); return BACKUP_DIR; });
step("mkdir caveMapsDir", () => { if (!fs.existsSync(caveMapsDir)) fs.mkdirSync(caveMapsDir); return caveMapsDir; });
step("mkdir geotiffDir", () => { if (!fs.existsSync(geotiffDir)) fs.mkdirSync(geotiffDir); return geotiffDir; });
step("mkdir shapefilesDir", () => { if (!fs.existsSync(shapefilesDir)) fs.mkdirSync(shapefilesDir); return shapefilesDir; });
step("mkdir caveMapsCollectionDir", () => { if (!fs.existsSync(caveMapsCollectionDir)) fs.mkdirSync(caveMapsCollectionDir, { recursive: true }); return caveMapsCollectionDir; });
step("mkdir sqliteHillshadesDir", () => { if (!fs.existsSync(sqliteHillshadesDir)) fs.mkdirSync(sqliteHillshadesDir, { recursive: true }); return sqliteHillshadesDir; });
step("mkdir NARRATIVE_DIR", () => { if (!fs.existsSync(NARRATIVE_DIR)) fs.mkdirSync(NARRATIVE_DIR, { recursive: true }); return NARRATIVE_DIR; });
step("mkdir CAVE_PICTURES_DIR", () => { if (!fs.existsSync(CAVE_PICTURES_DIR)) fs.mkdirSync(CAVE_PICTURES_DIR, { recursive: true }); return CAVE_PICTURES_DIR; });

step("read+parse USERS_FILE", () => {
  if (!fs.existsSync(USERS_FILE)) return "file does not exist";
  const data = fs.readFileSync(USERS_FILE, "utf-8");
  const parsed = JSON.parse(data);
  return `${data.length} bytes, ${Array.isArray(parsed) ? parsed.length : "?"} users`;
});
step("read+parse CAVE_DB_FILE", () => {
  if (!fs.existsSync(CAVE_DB_FILE)) return "file does not exist";
  const raw = fs.readFileSync(CAVE_DB_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return `${raw.length} bytes, ${Array.isArray(parsed) ? parsed.length : "?"} caves`;
});
step("read+parse STATES_CONFIG_FILE", () => {
  const raw = fs.readFileSync(STATES_CONFIG_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return `${raw.length} bytes, ${Array.isArray(parsed) ? parsed.length : "?"} states`;
});

const totalMs = Date.now() - t0;
const allOk = steps.every((s) => s.ok);

app.use((req, res) => {
  res.json({ totalMs, allOk, steps });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`full-init-check listening on port ${port}, totalMs=${totalMs}, allOk=${allOk}`);
});
