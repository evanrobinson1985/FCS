#!/usr/bin/env node
// Restores cave-database.json from one of its automatic timestamped
// backups (see backupDataFile() in server.js / bulk-import-caves-local.js,
// which both back up before every write). Always backs up the CURRENT
// file first, so this is itself undoable - nothing is ever discarded.
//
// Usage:
//   node scripts/restore-cave-database-backup.js --data-dir=/path/to/data --list
//     Lists available cave-database backups (newest first) with their
//     record counts, without changing anything.
//
//   node scripts/restore-cave-database-backup.js --data-dir=/path/to/data
//     Restores the single MOST RECENT backup (the default, usually what
//     you want right after an import you want to undo).
//
//   node scripts/restore-cave-database-backup.js --data-dir=/path/to/data --file=cave-database.2026-10-28T03-00-00-000Z.json
//     Restores a specific backup file by name (see --list for the names).
//
// (or set DATA_DIR / RESTORE_FILE / RESTORE_LIST=true as environment
// variables instead, same as bulk-import-caves-local.js, for running this
// through a host control panel's "run script" tool.)

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  let dataDir = null;
  let file = null;
  let list = false;
  for (const arg of argv) {
    if (arg === "--list") list = true;
    else if (arg.startsWith("--data-dir=")) dataDir = arg.slice("--data-dir=".length);
    else if (arg.startsWith("--file=")) file = arg.slice("--file=".length);
  }
  return { dataDir, file, list };
}

function countRecords(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed.length : "?";
  } catch (e) {
    return "?";
  }
}

function main() {
  const { dataDir: dataDirArg, file: fileArg, list: listArg } = parseArgs(process.argv.slice(2));
  const dataDir = dataDirArg || process.env.DATA_DIR;
  const requestedFile = fileArg || process.env.RESTORE_FILE;
  const listOnly = listArg || process.env.RESTORE_LIST === "true";

  if (!dataDir) {
    console.error("Usage: node scripts/restore-cave-database-backup.js --data-dir=/path/to/data [--list] [--file=<backup filename>]");
    process.exit(1);
  }

  const caveDbFile = path.join(dataDir, "cave-database.json");
  const backupDir = path.join(dataDir, "backups");
  if (!fs.existsSync(backupDir)) {
    console.error(`No backups directory found at ${backupDir}`);
    process.exit(1);
  }

  const backups = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith("cave-database.") && f.endsWith(".json"))
    .sort()
    .reverse(); // newest first (ISO timestamps in the filename sort lexicographically)

  if (backups.length === 0) {
    console.error(`No cave-database backups found in ${backupDir}`);
    process.exit(1);
  }

  console.log(`Current live database: ${fs.existsSync(caveDbFile) ? countRecords(caveDbFile) : "(missing)"} records\n`);
  console.log("Available backups (newest first):");
  backups.forEach((f, i) => {
    const count = countRecords(path.join(backupDir, f));
    console.log(`  ${i === 0 ? "-> " : "   "}${f}  (${count} records)`);
  });

  if (listOnly) {
    console.log("\n--list set: nothing was restored.");
    return;
  }

  const chosenFile = requestedFile || backups[0];
  const chosenPath = path.join(backupDir, chosenFile);
  if (!fs.existsSync(chosenPath)) {
    console.error(`\nBackup file not found: ${chosenPath}`);
    process.exit(1);
  }

  // Back up the current (about-to-be-replaced) file first, so this restore
  // is itself undoable.
  if (fs.existsSync(caveDbFile)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const preRestoreBackup = path.join(backupDir, `cave-database.${timestamp}.json`);
    fs.copyFileSync(caveDbFile, preRestoreBackup);
    console.log(`\nBacked up current database (before restoring) to ${preRestoreBackup}`);
  }

  fs.copyFileSync(chosenPath, caveDbFile);
  console.log(`Restored ${chosenFile} (${countRecords(chosenPath)} records) to ${caveDbFile}`);
  console.log("\nRestart the Node app in Plesk so the running server picks up the restored data.");
}

main();
