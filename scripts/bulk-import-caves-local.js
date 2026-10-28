#!/usr/bin/env node
// Imports a filled-in cave spreadsheet straight into cave-database.json on
// disk - no HTTP request involved at all, so nothing in front of the web
// server (Cloudflare, Apache, a WAF) can block it. Mirrors the validation
// and cave-ID-assignment logic of POST /api/cave-database/import in
// server.js exactly, so caves imported this way are indistinguishable from
// ones imported through the website. Run this ON the server (e.g. via
// Plesk's SSH Terminal), not from a laptop - it needs direct access to the
// real data directory.
//
// Usage:
//   node scripts/bulk-import-caves-local.js <path-to-xlsx> <stateCode> --data-dir=/path/to/data [--dry-run]
//
// Example (matches the DATA_DIR shown in Plesk's Node.js panel for this site):
//   node scripts/bulk-import-caves-local.js ~/AL_cave_import.xlsx AL \
//     --data-dir=/var/www/vhosts/fcs.caves.org/private/data
//
// --dry-run validates and reports without writing anything, so you can
// check the report first on a big file before committing to the real write.

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const CAVE_IMPORT_COLUMNS = [
  { header: "County", field: "county" },
  { header: "Record Type", field: "recordType" },
  { header: "Entrance No", field: "entranceNumber" },
  { header: "Line No", field: "lineNumber" },
  { header: "Cave Name", field: "name" },
  { header: "Township", field: "township" },
  { header: "Range", field: "range" },
  { header: "Section", field: "section" },
  { header: "Section Part", field: "sectionPart" },
  { header: "Sub-Part", field: "subPart" },
  { header: "Location Accuracy", field: "locationAccuracy" },
  { header: "USGS Quad", field: "usgsQuad" },
  { header: "Topo Symbol", field: "topoSymbol" },
  { header: "Elevation", field: "elevation" },
  { header: "Ownership", field: "ownership" },
  { header: "Entry Status", field: "entryStatus" },
  { header: "Equipment Needed", field: "equipment" },
  { header: "Entrance Type", field: "entranceType" },
  { header: "Field Indication", field: "fieldIndication" },
  { header: "Location Info Type", field: "locationInfo" },
  { header: "Map Type", field: "mapType" },
  { header: "Map Status", field: "mapStatus" },
  { header: "Geologic Formation", field: "geology" },
  { header: "Topographic Province", field: "topoProvince" },
  { header: "Cave Length", field: "length" },
  { header: "Vertical Extent", field: "vertical" },
  { header: "Max Water Depth", field: "waterDepth" },
  { header: "Deepest Pitch", field: "pitch" },
  { header: "Latitude", field: "latitude" },
  { header: "Longitude", field: "longitude" },
  { header: "Exploration Possibility", field: "exploration" },
  { header: "Reporter NSS #", field: "reporter" },
  { header: "Date YYMM", field: "date" },
  { header: "Cave Type", field: "type" },
  { header: "Hazardous Conditions", field: "hazardConditions" },
  { header: "Hazard Notes", field: "hazardNotes" },
  { header: "Owner/Entity Info", field: "ownerInfo" },
];

const LEGACY_FLORIDA_ID = /^F([A-Z]{2})\d+$/;

function resolveCaveStateAndCounty(cave) {
  if (!cave) return { state: null, county: null };
  let state = cave.state || null;
  let county = cave.county || null;
  if ((!state || !county) && cave.id) {
    const match = cave.id.match(LEGACY_FLORIDA_ID);
    if (match) {
      state = state || "FL";
      county = county || match[1];
    }
  }
  return { state, county };
}

function parseArgs(argv) {
  const positional = [];
  let dataDir = null;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else {
      positional.push(arg);
    }
  }
  return { positional, dataDir, dryRun };
}

function main() {
  const { positional, dataDir, dryRun } = parseArgs(process.argv.slice(2));
  const [xlsxPath, stateCode] = positional;

  if (!xlsxPath || !stateCode || !dataDir) {
    console.error(
      "Usage: node scripts/bulk-import-caves-local.js <path-to-xlsx> <stateCode> --data-dir=/path/to/data [--dry-run]"
    );
    process.exit(1);
  }

  const statesConfigPath = path.join(__dirname, "..", "config", "states.json");
  const statesConfig = JSON.parse(fs.readFileSync(statesConfigPath, "utf8")).states;
  const state = statesConfig.find((s) => s.code === stateCode);
  if (!state) {
    console.error(`Unknown state code "${stateCode}". Check config/states.json for valid codes.`);
    process.exit(1);
  }
  const validCountyCodes = new Set(state.counties.map((c) => c.code));
  const idPrefix = state.caveIdPrefix;

  if (!fs.existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`);
    process.exit(1);
  }
  const workbook = XLSX.read(fs.readFileSync(xlsxPath));
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (rows.length === 0) {
    console.error("The spreadsheet has no data rows.");
    process.exit(1);
  }
  console.log(`Read ${rows.length} rows from ${xlsxPath}`);

  const caveDbFile = path.join(dataDir, "cave-database.json");
  let caves = [];
  if (fs.existsSync(caveDbFile)) {
    caves = JSON.parse(fs.readFileSync(caveDbFile, "utf8"));
    if (!Array.isArray(caves)) caves = [];
  }
  console.log(`Loaded ${caves.length} existing caves from ${caveDbFile}`);

  // Same O(n) precompute as the server route: one pass to find each
  // county's current highest cave number, then increment per row instead
  // of rescanning the whole array on every row.
  const maxNumberByCounty = new Map();
  caves.forEach((cave) => {
    const resolved = resolveCaveStateAndCounty(cave);
    if (resolved.state !== stateCode || !resolved.county || !cave.id) return;
    const caveNumber = parseInt(cave.id.slice(idPrefix.length + resolved.county.length), 10);
    if (isNaN(caveNumber)) return;
    if (!maxNumberByCounty.has(resolved.county) || caveNumber > maxNumberByCounty.get(resolved.county)) {
      maxNumberByCounty.set(resolved.county, caveNumber);
    }
  });

  const report = [];
  let importedCount = 0;

  rows.forEach((row, i) => {
    const spreadsheetRow = i + 2; // 1-based, plus the header row
    const name = String(row["Cave Name"] || "").trim();
    const countyCode = String(row["County"] || "").trim().toUpperCase();
    const latitude = parseFloat(row["Latitude"]);
    const longitude = parseFloat(row["Longitude"]);

    if (!name) {
      report.push({ row: spreadsheetRow, status: "error", reason: "Missing Cave Name." });
      return;
    }
    if (!countyCode) {
      report.push({ row: spreadsheetRow, status: "error", reason: "Missing County.", name });
      return;
    }
    if (!validCountyCodes.has(countyCode)) {
      report.push({
        row: spreadsheetRow,
        status: "error",
        reason: `"${countyCode}" is not a valid county code for ${state.name}.`,
        name,
      });
      return;
    }
    if (isNaN(latitude) || isNaN(longitude)) {
      report.push({ row: spreadsheetRow, status: "error", reason: "Missing or invalid Latitude/Longitude.", name });
      return;
    }

    const newCave = { name, state: stateCode, county: countyCode, latitude, longitude, lat: latitude, lng: longitude };
    CAVE_IMPORT_COLUMNS.forEach(({ header, field }) => {
      if (["name", "county", "latitude", "longitude"].includes(field)) return;
      const value = row[header];
      if (value !== "" && value !== undefined && value !== null) {
        newCave[field] = value;
      }
    });

    const nextNumber = (maxNumberByCounty.get(countyCode) || 0) + 1;
    maxNumberByCounty.set(countyCode, nextNumber);
    const caveId = `${idPrefix}${countyCode}${nextNumber.toString().padStart(3, "0")}`;
    newCave.id = caveId;
    caves.push(newCave);
    importedCount++;
    report.push({ row: spreadsheetRow, status: "success", caveId, name });
  });

  const errors = report.filter((r) => r.status === "error");
  console.log(`\n${importedCount} of ${rows.length} row(s) would import, ${errors.length} error(s).`);
  if (errors.length > 0) {
    console.log("\nErrors:");
    errors.forEach((e) => console.log(`  row ${e.row}: ${e.reason}${e.name ? ` (${e.name})` : ""}`));
  }

  if (dryRun) {
    console.log("\n--dry-run set: nothing was written.");
    return;
  }
  if (importedCount === 0) {
    console.log("\nNothing to import - no changes made.");
    return;
  }

  // Backup before writing, same as the server's backupDataFile().
  const backupDir = path.join(dataDir, "backups");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(caveDbFile)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `cave-database.${timestamp}.json`);
    fs.copyFileSync(caveDbFile, backupPath);
    console.log(`\nBacked up existing database to ${backupPath}`);
  }

  fs.writeFileSync(caveDbFile, JSON.stringify(caves, null, 2), "utf8");
  console.log(`Wrote ${caves.length} total caves to ${caveDbFile}`);
  console.log(
    "\nRestart the Node app in Plesk (or wait for it to reload) so the running server picks up the new data."
  );
}

main();
