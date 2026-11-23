#!/usr/bin/env node
// One-time repair for duplicates created by the first run of
// merge-master-survey.js. That script matched master-file rows to existing
// caves by exact "county+number" ID only. Two situations slipped past that:
//
// 1. A handful of older multi-entrance caves were historically stored as
//    separate flat records with a letter-suffixed ID per entrance (e.g.
//    FJK0227a, FJK0227b), rather than nested under one base ID's
//    `entrances` array. The master file's first "Entrance" row for that
//    same cave number doesn't match either suffixed ID, so the merge
//    treated it as a brand new cave and created an unsuffixed duplicate
//    (FJK0227) alongside the real ones.
// 2. A few master-file rows had a typo'd county code matching an existing
//    cave's name/coordinates under the *correct* county (e.g. "Forest Sink
//    Cave" logged as county "HE" in the survey, when the real cave is
//    FHO1465 in Hernando ("HO") - already in production, hand-documented
//    by its own discoverer).
//
// Found by comparing the merge's output against a pre-merge backup for
// exact/near-exact name + coordinate matches. This script merges each
// duplicate's real data into its rightful sibling and then removes the
// duplicate record - but unlike the original merge, it only FILLS BLANK
// fields on the sibling; it never overwrites a value the sibling already
// has. A duplicate here is a matching artifact (a mismatched county code,
// or an old flat-record convention the matcher didn't know about), not a
// deliberate newer survey update, so the sibling's own already-recorded
// value is trusted over it on a conflict (equipment is still unioned,
// notes still appended, entrances still appended - nothing with its own
// clear "combine, don't choose" rule needs to pick a side).
//
// Usage:
//   node scripts/fix-merge-duplicates.js --data-dir=/path/to/data [--write]
// Via Plesk's "Run Node.js commands" (npm) tool:
//   run fix-merge-duplicates -- --data-dir=/path/to/data [--write]

const fs = require("fs");
const os = require("os");
const path = require("path");

function expandHome(p) {
  if (p && p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function parseArgs(argv) {
  let dataDir = null;
  let write = false;
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else if (arg.startsWith("--data-dir=")) dataDir = arg.slice("--data-dir=".length);
  }
  return { dataDir, write };
}

const { dataDir: dataDirArg, write: writeArg } = parseArgs(process.argv.slice(2));
const dataDir = expandHome(dataDirArg || process.env.DATA_DIR);
const doWrite = writeArg || process.env.FIX_DUPLICATES_WRITE === "true";

if (!dataDir) {
  console.error(
    "Usage: node scripts/fix-merge-duplicates.js --data-dir=/path/to/data [--write]\n" +
    "(or set DATA_DIR / FIX_DUPLICATES_WRITE=true as environment variables instead)"
  );
  process.exit(1);
}

// [duplicateId, rightfulSiblingId] - confirmed by exact/near-exact name and
// coordinate match against the pre-merge backup. Each duplicate's
// `createdBy` is checked below before touching it, as a safety margin in
// case one was already manually cleaned up.
const DUPLICATE_PAIRS = [
  ["FJK0227", "FJK0227b"], ["FHE1465", "FHO1465"], ["FAL0092", "FAL0092b"], ["FPA0222", "FPA0222d"],
  ["FJK0229", "FJK0229a"], ["FLV0246", "FLV0246c"], ["FMA0326", "FMA0326a"], ["FSF0342", "FSF0342d"],
  ["FGC0357", "FGC0357a"], ["FGC0372", "FGC0372b"], ["FJK0436", "FJK0436a"], ["FGC0454", "FGC0454a"],
  ["FHA0474", "FHA0474a"], ["FPN0488", "FPN0488a"], ["FMR0520", "FMR0520b"], ["FAL0607", "FAL0607b"],
  ["FJK0611", "FJK0611a"], ["FLL0670", "FLL0670a"], ["FWU0670", "FWU0670b"], ["FAL1286", "FAL1286a"],
  ["FCI1288", "FHO1288"], ["FCI1289", "FHO1289"], ["FAL1303", "FAL1303d"], ["FCU1370", "FCU1370a"],
  ["FSF1421", "FSF1421b"], ["FCI1442", "FHO1442"], ["FCI1443", "FHO1443"],
];

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

function isEmpty(v) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

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
console.log(`Loaded ${caves.length} caves from ${caveDbFile}`);

const byId = new Map(caves.map((c) => [c.id, c]));
const now = new Date().toISOString();
const report = [];

for (const [dupId, keepId] of DUPLICATE_PAIRS) {
  const dup = byId.get(dupId);
  const keep = byId.get(keepId);
  if (!dup) {
    report.push({ dupId, keepId, status: "skipped", reason: "duplicate not found (already removed?)" });
    continue;
  }
  if (!keep) {
    report.push({ dupId, keepId, status: "skipped", reason: "sibling not found - leaving duplicate alone" });
    continue;
  }
  if (dup.createdBy !== "merge-master-survey script") {
    report.push({ dupId, keepId, status: "skipped", reason: `createdBy is "${dup.createdBy}", not this script - someone may have already edited it` });
    continue;
  }

  const filledFields = [];
  for (const field of MERGE_FIELDS) {
    if (field === "name") continue;
    const dupVal = dup[field];
    if (isEmpty(dupVal)) continue;
    if (isEmpty(keep[field])) {
      keep[field] = dupVal;
      filledFields.push(field);
    }
  }

  const keepEquip = normalizeEquipmentToArray(keep.equipment);
  const dupEquip = normalizeEquipmentToArray(dup.equipment);
  if (dupEquip.length) {
    const union = Array.from(new Set([...keepEquip, ...dupEquip])).sort();
    if (JSON.stringify(union) !== JSON.stringify(keep.equipment)) {
      keep.equipment = union;
      filledFields.push("equipment");
    }
  }

  if (dup.notes && !(keep.notes || "").includes(dup.notes)) {
    keep.notes = keep.notes ? `${keep.notes}\n${dup.notes}` : dup.notes;
    filledFields.push("notes");
  }

  if (Array.isArray(dup.entrances) && dup.entrances.length) {
    keep.entrances = Array.isArray(keep.entrances) ? keep.entrances.concat(dup.entrances) : dup.entrances;
    filledFields.push(`entrances (+${dup.entrances.length})`);
  }

  if (filledFields.length) {
    keep.lastUpdated = now;
    keep.updatedBy = "fix-merge-duplicates script";
  }

  caves = caves.filter((c) => c.id !== dupId);
  byId.delete(dupId);
  report.push({ dupId, keepId, status: "merged and removed", filledFields });
}

console.log("\n" + JSON.stringify(report, null, 1));
const mergedCount = report.filter((r) => r.status === "merged and removed").length;
console.log(`\n${mergedCount} duplicate(s) merged into their rightful sibling and removed, ${report.length - mergedCount} skipped.`);

if (!doWrite) {
  console.log("\n--write not set: nothing was saved. Re-run with --write to apply this for real.");
  process.exit(0);
}
if (mergedCount === 0) {
  console.log("\nNothing to apply - no changes made.");
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
