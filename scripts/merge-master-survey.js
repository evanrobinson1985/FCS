#!/usr/bin/env node
// Merges the "Florida Cave Survey MASTER" workbook (the FCS's own multi-row-
// per-cave survey export) into the real cave-database.json on disk. Mirrors
// bulk-import-caves-local.js: run this ON the server (e.g. via Plesk's "Run
// Node.js commands"), not from a laptop - it needs direct access to the real
// data directory, and bypasses HTTP entirely (nothing in front of the web
// server can block or time out a write made straight to disk).
//
// Usage:
//   node scripts/merge-master-survey.js <path-to-master.xlsx> --data-dir=/path/to/data [--write]
//
// From Plesk's "Run Node.js commands" tool (which runs "npm <what you
// type>", not a raw node command - typing "node scripts/..." there fails
// with "Unknown command: node"), use the npm script instead, with "--"
// before the script's own arguments:
//   run merge-master-survey -- <path-to-master.xlsx> --data-dir=/path/to/data [--write]
// Or set MERGE_MASTER_FILE / DATA_DIR / MERGE_WRITE=true as environment
// variables and just type: run merge-master-survey
//
// Without --write, this only prints the same before/after summary a dry run
// would (nothing is saved) - the preview already shown to the webmaster
// before running this for real. Pass --write to actually save, after taking
// a timestamped backup of cave-database.json first.
//
// Conflict policy: where the survey disagrees with an existing field, the
// survey wins (the master file is the newer, authoritative source) - this
// was confirmed with the webmaster from the dry-run report before this
// script was written. Caves the master file doesn't mention at all are
// left completely untouched.
//
// Equipment is the one exception: it's multi-valued (an array of letter
// codes, e.g. ["K","N","R"]), and the survey's own codebook is older and
// often only recorded one or two letters per cave where the real cave
// already had more recorded. Overwriting outright would silently drop
// already-known equipment, so this unions the two instead of replacing.
// (A first run of an earlier version of this script did overwrite it, as
// a plain string instead of an array to boot - safe to re-run now, since
// the union of a set with itself changes nothing and every other field's
// "survey wins" overwrite is idempotent.)

const fs = require("fs");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");

// Plesk's "Run Node.js commands" tool execs node directly rather than
// through a shell, so a leading "~" in a path (as in the usage examples
// above) never gets expanded to the home directory the way it would on a
// normal command line - it's passed through literally and fails with
// "File not found: ~/...". Expand it ourselves.
function expandHome(p) {
  if (p && p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function parseArgs(argv) {
  const positional = [];
  let dataDir = null;
  let write = false;
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else if (arg.startsWith("--data-dir=")) dataDir = arg.slice("--data-dir=".length);
    else positional.push(arg);
  }
  return { positional, dataDir, write };
}

const { positional, dataDir: dataDirArg, write: writeArg } = parseArgs(process.argv.slice(2));
const masterPath = expandHome(positional[0] || process.env.MERGE_MASTER_FILE);
const dataDir = expandHome(dataDirArg || process.env.DATA_DIR);
const doWrite = writeArg || process.env.MERGE_WRITE === "true";

if (!masterPath || !dataDir) {
  console.error(
    "Usage: node scripts/merge-master-survey.js <path-to-master.xlsx> --data-dir=/path/to/data [--write]\n" +
    "(or set MERGE_MASTER_FILE / DATA_DIR / MERGE_WRITE=true as environment variables instead)"
  );
  process.exit(1);
}
if (!fs.existsSync(masterPath)) {
  console.error(`File not found: ${masterPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reverse code maps, copied exactly from the option lists in the Add/Edit
// Cave form in portal.html (entryStatusOptions @1526 / #edit-entry-status
// @1251, entranceTypeOptions @5847 / #edit-entrance-type @1191,
// fieldIndicationOptions @5867 / #edit-field-indication @1220,
// geologyOptions @5913 / #edit-geology @1347, #edit-topo-province @1359,
// #edit-map-status @1337, #edit-location-accuracy @1163, equipment
// checkboxes @1273-1316).
// ---------------------------------------------------------------------------
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.'’]/g, "")
    .replace(/\bverv\b/g, "very")
    .replace(/\bsprinq\b/g, "spring")
    .replace(/\bquarrv\b/g, "quarry")
    .replace(/\bgroud\b/g, "ground")
    .replace(/\breauired\b/g, "required");
}

function buildReverseMap(options, extraAliases) {
  const map = new Map();
  for (const { code, label } of options) map.set(norm(label), code);
  for (const [alias, code] of Object.entries(extraAliases || {})) map.set(norm(alias), code);
  return (rawValue) => {
    const key = norm(rawValue);
    if (!key) return { code: null, reason: "blank" };
    if (map.has(key)) return { code: map.get(key), reason: "matched" };
    return { code: null, reason: "unmapped" };
  };
}

const resolveEntryStatus = buildReverseMap(
  [
    { code: "C", label: "Commercial" },
    { code: "D", label: "Destroyed or closed" },
    { code: "F", label: "Forbidden by owner" },
    { code: "G", label: "Government owned" },
    { code: "K", label: "Government park" },
    { code: "L", label: "Locked or gated" },
    { code: "N", label: "Non-government preserve" },
    { code: "P", label: "Private property" },
    { code: "R", label: "Permission required" },
    { code: "W", label: "Waiver required" },
  ],
  { "forbidden bv owner": "F", destored: "D", destroyed: "D", "locked or gated": "L", gated: "L" }
);

const resolveEntranceType = buildReverseMap(
  [
    { code: "E", label: "Large Horizontal (20'+)" },
    { code: "K", label: "Crawl" },
    { code: "L", label: "Large walk-in" },
    { code: "H", label: "Stoop or Duck Walk" },
    { code: "T", label: "Artificial tunnel" },
    { code: "A", label: "Artificial shaft" },
    { code: "B", label: "Bottleneck/small but bells out" },
    { code: "C", label: "Chimney or Climb" },
    { code: "O", label: "Very wide pit (20'+)" },
    { code: "P", label: "Pit" },
    { code: "S", label: "Tight pit" },
  ],
  { "large walk in": "L", "stoop/duck walk": "H", "large horizontal 20'+": "E", "tight pit": "S" }
);

const resolveFieldIndication = buildReverseMap(
  [
    { code: "B", label: "Bluff or outcrop" },
    { code: "F", label: "Flat ground" },
    { code: "H", label: "Dry hillside" },
    { code: "I", label: "In-flowing stream" },
    { code: "O", label: "Obscure" },
    { code: "Q", label: "Quarry" },
    { code: "S", label: "Sink (dry)" },
    { code: "T", label: "Tree cluster" },
    { code: "W", label: "Wet weather stream" },
    { code: "P", label: "Lake, pond or pool" },
    { code: "X", label: "Spring" },
  ],
  { sink: "S", "in flowing stream": "I", "bluff or outcrop": "B" }
);

const resolveGeology = buildReverseMap([
  { code: "HA", label: "Hawthorne Formation" },
  { code: "CH", label: "Chattahoochee Formation" },
  { code: "SU", label: "Suwannee Formation" },
  { code: "MA", label: "Marianna Formation" },
  { code: "CR", label: "Crystal River Formation" },
  { code: "OC", label: "Ocala Limestone" },
], {});

const resolveTopoProvince = buildReverseMap([
  { code: "B", label: "Brooksville Ridge" },
  { code: "D", label: "Dade County" },
  { code: "F", label: "Santa Fe River Basin" },
  { code: "N", label: "Newberry Karst Plain" },
  { code: "O", label: "Ocala Karst" },
  { code: "P", label: "Panhandle" },
  { code: "S", label: "Suwannee Valley" },
  { code: "T", label: "Tampa Karst" },
  { code: "W", label: "Wakulla Karst Plain" },
], {});

const resolveMapStatus = buildReverseMap(
  [
    { code: "I", label: "Improved Map" },
    { code: "N", label: "New Map / Survey" },
    { code: "P", label: "In Progress" },
    { code: "R", label: "Redraw of Old Map" },
  ],
  { "new map/ survey": "N", "new map survey": "N" }
);

const LOCATION_ACCURACY_BUCKETS = [
  { code: "D", feet: 5 }, { code: "E", feet: 10 }, { code: "F", feet: 20 },
  { code: "G", feet: 30 }, { code: "H", feet: 55 }, { code: "I", feet: 100 },
  { code: "J", feet: 200 }, { code: "K", feet: 300 }, { code: "L", feet: 550 },
  { code: "M", feet: 1000 },
];
function resolveLocationAccuracy(raw) {
  const key = norm(raw).replace(/\brouoh\b/g, "rough");
  if (!key) return { code: null, reason: "blank" };
  if (key.includes("unknown") || key.includes("rough estimate")) return { code: "U", reason: "matched" };
  if (key.includes("mapped")) return { code: "N", reason: "matched" };
  const digits = key.replace(/[^0-9]/g, "");
  if (!digits) return { code: null, reason: "unmapped" };
  const feet = parseInt(digits, 10);
  let best = LOCATION_ACCURACY_BUCKETS[0];
  let bestDist = Math.abs(feet - best.feet);
  for (const bucket of LOCATION_ACCURACY_BUCKETS) {
    const dist = Math.abs(feet - bucket.feet);
    if (dist < bestDist) { best = bucket; bestDist = dist; }
  }
  return { code: best.code, reason: "matched" };
}

const VALID_EQUIPMENT_LETTERS = new Set(["B", "D", "H", "K", "L", "N", "R", "S", "W", "X"]);
function resolveEquipment(raw) {
  const letters = String(raw || "").trim().toUpperCase().split("").filter((c) => /[A-Z]/.test(c));
  const valid = letters.filter((c) => VALID_EQUIPMENT_LETTERS.has(c));
  const dropped = letters.filter((c) => !VALID_EQUIPMENT_LETTERS.has(c));
  return { letters: valid, dropped };
}

const BLANK_LIKE = new Set(["", " ", "-", "unknown", "unknown status"]);

// ---------------------------------------------------------------------------
// Load and group the master survey workbook into one object per cave.
// ---------------------------------------------------------------------------
function loadMasterCaves(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets["FCS Index"];
  if (!ws) {
    console.error('Expected a sheet named "FCS Index" in the master workbook.');
    process.exit(1);
  }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  const header = rows[0];
  const idx = (name) => header.indexOf(name);
  const col = {
    county: idx("County"),
    number: idx("Cave Number"),
    recordType: idx("Record Type"),
    name: idx("Cave Name"),
    locationAccuracy: idx("Accuracy of locatIon"),
    usgsQuad: idx("Quad # USGS 7 5' Topograph Map"),
    topoSymbol: idx("Indication of Ent on Topograph Map"),
    elevation: idx("ELEVATION"),
    ownership: idx("Ownnershp Status"),
    entryStatus: idx("Entrv Status"),
    equipment: idx("Specail Equment"),
    entranceType: idx("Type of Entrance"),
    fieldIndication: idx("Indication of Entrance in the Field"),
    locationInfo: idx("Original Location Information"),
    mapType: idx("Cave Map Grade and Survey Data  Grade"),
    mapStatus: idx("Cave Map Status"),
    geology: idx("Geologic Formation at Entrance"),
    topoProvince: idx("Topographic Provine "),
    length: idx("True Horizontal Distance"),
    vertical: idx("True Vertical Distance"),
    waterDepth: idx("Maximum Water Depth of Cave"),
    pitch: idx("Depth of Deepest Single Single Pitch"),
    latitude: idx("LATITUDE"),
    longitude: idx("LONGITUDE"),
    exploration: idx("Possiblities of Futer Exploration"),
    reporter: idx("Reporter NSS#"),
    date: idx("Date of Re port YYMM"),
  };
  for (const [key, i] of Object.entries(col)) {
    if (i === -1) console.error(`Warning: expected column for "${key}" not found in master workbook header.`);
  }

  const dataRows = rows.slice(1).filter((r) => r.some((c) => c !== "" && c !== null && c !== undefined));

  const groups = new Map();
  for (const r of dataRows) {
    const county = String(r[col.county] || "").trim().toUpperCase();
    const number = parseInt(r[col.number], 10);
    if (!county || isNaN(number)) continue; // garbage/typo rows (e.g. the one State=0 row)
    const key = county + "|" + number;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const STRUCTURAL_TYPES = new Set(["Entrance", "Cave", "Karst Featu re"]);
  const caves = [];
  const skippedNoStructural = [];

  for (const [key, groupRows] of groups) {
    const [county, numberStr] = key.split("|");
    const number = parseInt(numberStr, 10);
    const entranceRows = groupRows.filter((r) => r[col.recordType] === "Entrance");
    const caveRow = groupRows.find((r) => r[col.recordType] === "Cave");
    const karstRow = groupRows.find((r) => r[col.recordType] === "Karst Featu re");
    const notesRows = groupRows.filter((r) => !STRUCTURAL_TYPES.has(r[col.recordType]));

    const primaryStructuralRow = caveRow || entranceRows[0] || karstRow;
    if (!primaryStructuralRow) {
      skippedNoStructural.push({ county, number, text: groupRows.map((r) => r[col.name]).filter(Boolean).join(" / ") });
      continue;
    }

    const fieldsRow = entranceRows[0] || caveRow || karstRow;
    const nameRow = fieldsRow;

    const notesLines = [];
    for (const r of notesRows) {
      const type = String(r[col.recordType]).trim().replace(/\s+/g, " ");
      const text = String(r[col.name] || "").trim();
      if (text) notesLines.push(`${type}: ${text}`);
    }
    if (caveRow && entranceRows[0]) {
      const caveRowName = String(caveRow[col.name] || "").trim();
      const entranceName = String(entranceRows[0][col.name] || "").trim();
      if (caveRowName && caveRowName.toLowerCase() !== entranceName.toLowerCase()) {
        notesLines.push(`Cave record: ${caveRowName}`);
      }
    }

    const entryStatusRaw = fieldsRow[col.entryStatus];
    const entranceTypeRaw = fieldsRow[col.entranceType];
    const fieldIndicationRaw = fieldsRow[col.fieldIndication];
    const geologyRaw = fieldsRow[col.geology];
    const topoProvinceRaw = fieldsRow[col.topoProvince];
    const mapStatusRaw = fieldsRow[col.mapStatus];
    const mapGradeRaw = fieldsRow[col.mapType];
    const locationAccuracyRaw = fieldsRow[col.locationAccuracy];
    const equipmentRaw = fieldsRow[col.equipment];

    const entryStatusResolved = resolveEntryStatus(entryStatusRaw);
    const entranceTypeResolved = resolveEntranceType(entranceTypeRaw);
    const fieldIndicationResolved = resolveFieldIndication(fieldIndicationRaw);
    const geologyResolved = resolveGeology(geologyRaw);
    const topoProvinceResolved = resolveTopoProvince(topoProvinceRaw);
    const mapStatusResolved = resolveMapStatus(mapStatusRaw);
    const locationAccuracyResolved = resolveLocationAccuracy(locationAccuracyRaw);
    const equipmentResolved = resolveEquipment(equipmentRaw);

    if (entryStatusResolved.reason === "unmapped" && String(entryStatusRaw).trim()) {
      notesLines.push(`Entry status (from survey, not auto-coded): ${String(entryStatusRaw).trim()}`);
    }
    if (entranceTypeResolved.reason === "unmapped" && String(entranceTypeRaw).trim()) {
      notesLines.push(`Entrance type (from survey, not auto-coded): ${String(entranceTypeRaw).trim()}`);
    }
    if (fieldIndicationResolved.reason === "unmapped" && String(fieldIndicationRaw).trim()) {
      notesLines.push(`Field indication (from survey, not auto-coded): ${String(fieldIndicationRaw).trim()}`);
    }
    if (String(mapGradeRaw || "").trim() && !BLANK_LIKE.has(String(mapGradeRaw).trim().toLowerCase())) {
      notesLines.push(`Map survey grade/method (from survey, not auto-coded): ${String(mapGradeRaw).trim()}`);
    }
    if (equipmentResolved.dropped.length) {
      notesLines.push(`Equipment codes from survey not in our list: ${equipmentResolved.dropped.join("")}`);
    }

    const pick = (v) => {
      const s = typeof v === "string" ? v.trim() : v;
      return s === "" || s === undefined || s === null ? undefined : s;
    };

    const cave = {
      id: `F${county}${String(number).padStart(4, "0")}`,
      county,
      number,
      name: String(nameRow[col.name] || "").trim(),
      latitude: pick(fieldsRow[col.latitude]),
      longitude: pick(fieldsRow[col.longitude]),
      elevation: pick(fieldsRow[col.elevation]),
      locationAccuracy: locationAccuracyResolved.code || undefined,
      usgsQuad: pick(fieldsRow[col.usgsQuad]),
      topoSymbol: pick(fieldsRow[col.topoSymbol]),
      ownership: pick(fieldsRow[col.ownership]),
      entryStatus: entryStatusResolved.code || undefined,
      equipment: equipmentResolved.letters.length ? equipmentResolved.letters : undefined,
      entranceType: entranceTypeResolved.code || undefined,
      fieldIndication: fieldIndicationResolved.code || undefined,
      locationInfo: pick(fieldsRow[col.locationInfo]),
      mapStatus: mapStatusResolved.code || undefined,
      geology: geologyResolved.code || undefined,
      topoProvince: topoProvinceResolved.code || undefined,
      length: pick(fieldsRow[col.length]),
      vertical: pick(fieldsRow[col.vertical]),
      waterDepth: pick(fieldsRow[col.waterDepth]),
      pitch: pick(fieldsRow[col.pitch]),
      exploration: pick(fieldsRow[col.exploration]),
      reporter: pick(fieldsRow[col.reporter]),
      date: pick(fieldsRow[col.date]),
      entrances: [],
      notes: notesLines.join("\n"),
    };

    for (const r of entranceRows.slice(1)) {
      const es = resolveEntryStatus(r[col.entryStatus]);
      const et = resolveEntranceType(r[col.entranceType]);
      const fi = resolveFieldIndication(r[col.fieldIndication]);
      cave.entrances.push({
        name: String(r[col.name] || "").trim() || cave.name,
        entranceType: et.code || undefined,
        fieldIndication: fi.code || undefined,
        entryStatus: es.code || undefined,
        locationAccuracy: resolveLocationAccuracy(r[col.locationAccuracy]).code || undefined,
        latitude: pick(r[col.latitude]),
        longitude: pick(r[col.longitude]),
        elevation: pick(r[col.elevation]),
      });
    }

    caves.push(cave);
  }

  return { caves, skippedNoStructural };
}

// ---------------------------------------------------------------------------
// Apply to the real cave-database.json.
// ---------------------------------------------------------------------------
// Equipment is handled separately below (array union, not overwrite).
const MERGE_FIELDS = [
  "name", "latitude", "longitude", "elevation", "locationAccuracy", "usgsQuad",
  "topoSymbol", "ownership", "entryStatus", "entranceType",
  "fieldIndication", "locationInfo", "mapStatus", "geology", "topoProvince",
  "length", "vertical", "waterDepth", "pitch", "exploration", "reporter", "date",
];

function normalizeEquipmentToArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split("").filter((c) => /[A-Z]/i.test(c));
  return [];
}

const { caves: masterCaves, skippedNoStructural } = loadMasterCaves(masterPath);
console.log(`Read ${masterCaves.length} caves from the master survey file (${skippedNoStructural.length} retired/pointer-only rows skipped, no name or coordinates to merge).`);

const caveDbFile = path.join(dataDir, "cave-database.json");
if (!fs.existsSync(caveDbFile)) {
  console.error(`No cave-database.json found at ${caveDbFile}`);
  process.exit(1);
}
let caves = JSON.parse(fs.readFileSync(caveDbFile, "utf8"));
if (!Array.isArray(caves)) {
  console.error(`${caveDbFile} does not contain a JSON array.`);
  process.exit(1);
}
console.log(`Loaded ${caves.length} existing caves from ${caveDbFile}`);

const byId = new Map(caves.map((c) => [c.id, c]));
const now = new Date().toISOString();
let addedCount = 0;
let updatedCount = 0;

for (const masterCave of masterCaves) {
  const existing = byId.get(masterCave.id);
  if (!existing) {
    const newCave = {
      id: masterCave.id,
      state: "FL",
      county: masterCave.county,
      name: masterCave.name,
      type: "Land Cave",
      latitude: masterCave.latitude,
      longitude: masterCave.longitude,
      lat: masterCave.latitude,
      lng: masterCave.longitude,
      entrances: masterCave.entrances,
      notes: masterCave.notes,
      equipment: masterCave.equipment || [],
      createdDate: now,
      createdBy: "merge-master-survey script",
      lastUpdated: now,
      updatedBy: "merge-master-survey script",
    };
    for (const field of MERGE_FIELDS) {
      if (field === "name") continue;
      if (masterCave[field] !== undefined) newCave[field] = masterCave[field];
    }
    caves.push(newCave);
    byId.set(newCave.id, newCave);
    addedCount++;
    continue;
  }

  // Survey wins: overwrite any field the master file has a value for.
  let changed = false;
  for (const field of MERGE_FIELDS) {
    const val = masterCave[field];
    if (val === undefined) continue;
    if (existing[field] !== val) {
      existing[field] = val;
      changed = true;
    }
  }
  if (masterCave.latitude !== undefined) { existing.lat = masterCave.latitude; changed = true; }
  if (masterCave.longitude !== undefined) { existing.lng = masterCave.longitude; changed = true; }
  if (masterCave.equipment && masterCave.equipment.length > 0) {
    const existingLetters = normalizeEquipmentToArray(existing.equipment);
    const union = Array.from(new Set([...existingLetters, ...masterCave.equipment])).sort();
    if (JSON.stringify(union) !== JSON.stringify(existing.equipment)) {
      existing.equipment = union;
      changed = true;
    }
  }
  if (masterCave.entrances.length > 0) {
    existing.entrances = masterCave.entrances;
    changed = true;
  }
  if (masterCave.notes) {
    const already = (existing.notes || "").includes(masterCave.notes);
    if (!already) {
      existing.notes = existing.notes ? `${existing.notes}\n${masterCave.notes}` : masterCave.notes;
      changed = true;
    }
  }
  if (changed) {
    existing.lastUpdated = now;
    existing.updatedBy = "merge-master-survey script";
    updatedCount++;
  }
}

console.log(`\n${addedCount} new cave(s) to add, ${updatedCount} existing cave(s) to update.`);

if (!doWrite) {
  console.log("\n--write not set: nothing was saved. Re-run with --write to apply this for real.");
  process.exit(0);
}

const backupDir = path.join(dataDir, "backups");
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `cave-database.${timestamp}.json`);
fs.copyFileSync(caveDbFile, backupPath);
console.log(`\nBacked up existing database to ${backupPath}`);

fs.writeFileSync(caveDbFile, JSON.stringify(caves, null, 2), "utf8");
console.log(`Wrote ${caves.length} total caves to ${caveDbFile}`);
console.log("\nRestart the Node app in Plesk (or wait for it to reload) so the running server picks up the new data.");
