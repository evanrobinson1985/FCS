// Full-site snapshots: every data file the website needs, in one compressed
// file, so the whole site's data can be put back in one step after an
// accident or a malicious change.
//
// A snapshot holds the exact text of each data file (accounts, cave
// database, submissions, settings, narratives, ...) plus a SHA-256 checksum
// of all of it, so a damaged or edited snapshot is refused rather than
// restored. Snapshots are kept by date (not by number of edits), so a burst
// of bad changes can't push the good copies out.
//
// Photos and cave map files (large binary files) are not included; Plesk's
// own backups cover those.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const FORMAT = "fcs-snapshot";
const DAY_MS = 24 * 60 * 60 * 1000;

function createSnapshotStore({ dir, files, narrativeDir, writeFileAtomicSync }) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  function readText(file) {
    try {
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    } catch {
      return null;
    }
  }

  function readNarratives() {
    const out = {};
    if (!narrativeDir || !fs.existsSync(narrativeDir)) return out;
    for (const f of fs.readdirSync(narrativeDir)) {
      if (f.endsWith(".json")) out[f] = fs.readFileSync(path.join(narrativeDir, f), "utf8");
    }
    return out;
  }

  function countsOf(fileTexts, narratives) {
    const len = (text) => {
      try {
        const v = JSON.parse(text);
        return Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
      } catch {
        return 0;
      }
    };
    let narrativeCount = 0;
    for (const [name, text] of Object.entries(narratives || {})) {
      if (name === "deletion-log.json") continue;
      narrativeCount += Math.max(1, len(text));
    }
    return {
      accounts: fileTexts.users ? len(fileTexts.users) : 0,
      caves: fileTexts.caveDatabase ? len(fileTexts.caveDatabase) : 0,
      submissions: fileTexts.submissions ? len(fileTexts.submissions) : 0,
      narratives: narrativeCount,
      narrativeCaves: Object.keys(narratives || {}).filter((n) => n !== "deletion-log.json").length,
    };
  }

  function checksum(payload) {
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  // What the site holds right now, in snapshot form
  function capture(reason, by) {
    const fileTexts = {};
    for (const [key, file] of Object.entries(files)) fileTexts[key] = readText(file);
    const narratives = readNarratives();
    const payload = { files: fileTexts, narratives };
    return {
      format: FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      reason,
      by: by || "system",
      counts: countsOf(fileTexts, narratives),
      sha256: checksum(payload),
      ...payload,
    };
  }

  function idFor(snapshot) {
    return `${snapshot.createdAt.replace(/[:.]/g, "-")}-${snapshot.reason}`;
  }

  function fileFor(id) {
    if (!/^[A-Za-z0-9-]{10,80}$/.test(String(id))) return null;
    const file = path.join(dir, `${id}.json.gz`);
    return fs.existsSync(file) ? file : null;
  }

  function save(snapshot) {
    const id = idFor(snapshot);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)));
    writeFileAtomicSync(path.join(dir, `${id}.json.gz`), gz);
    // A small index entry beside it, so listing doesn't unpack every snapshot
    const meta = { id, createdAt: snapshot.createdAt, reason: snapshot.reason, by: snapshot.by, counts: snapshot.counts, size: gz.length };
    writeFileAtomicSync(path.join(dir, `${id}.meta.json`), JSON.stringify(meta));
    return meta;
  }

  function create(reason, by) {
    const snapshot = capture(reason, by);
    const meta = save(snapshot);
    prune();
    return meta;
  }

  function list() {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter((m) => m && fileFor(m.id))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // Parses snapshot bytes (gzipped or plain JSON) and checks them over.
  // Returns { snapshot } or { error }.
  function parse(buffer) {
    let text;
    try {
      text = buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
    } catch {
      return { error: "That file couldn't be unpacked." };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { error: "That file isn't a backup made by this website." };
    }
    if (!data || typeof data !== "object") return { error: "That file isn't a backup made by this website." };

    // The older "Download Backup Now" file: accounts, caves, submissions and
    // settings only (no narratives) - accepted, and narratives are left alone
    if (data.format !== FORMAT && Array.isArray(data.users) && Array.isArray(data.caveDatabase)) {
      const fileTexts = {
        users: JSON.stringify(data.users, null, 2),
        caveDatabase: JSON.stringify(data.caveDatabase, null, 2),
        submissions: JSON.stringify(Array.isArray(data.pendingSubmissions) ? data.pendingSubmissions : [], null, 2),
        siteConfig: data.siteConfig && typeof data.siteConfig === "object" ? JSON.stringify(data.siteConfig, null, 2) : null,
      };
      return {
        snapshot: {
          format: FORMAT, version: 1, legacy: true, createdAt: data.exportedAt || null, reason: "older-backup", by: "",
          counts: countsOf(fileTexts, {}), files: fileTexts, narratives: null,
        },
      };
    }

    if (data.format !== FORMAT || !data.files || typeof data.files !== "object") {
      return { error: "That file isn't a backup made by this website." };
    }
    if (checksum({ files: data.files, narratives: data.narratives }) !== data.sha256) {
      return { error: "This backup has been changed or damaged since it was made (its checksum doesn't match), so it won't be restored." };
    }
    return { snapshot: data };
  }

  function read(id) {
    const file = fileFor(id);
    if (!file) return { error: "Backup not found." };
    return parse(fs.readFileSync(file));
  }

  // The data must look like this site's before anything is overwritten
  function validate(snapshot) {
    const f = snapshot.files || {};
    const parsed = {};
    for (const [key, text] of Object.entries(f)) {
      if (text === null || text === undefined) continue;
      if (!(key in files)) return `Unknown file "${key}" in the backup.`;
      if (typeof text !== "string") return `"${key}" in the backup isn't readable.`;
      try {
        parsed[key] = JSON.parse(text);
      } catch {
        return `"${key}" in the backup isn't valid data.`;
      }
    }
    if (!Array.isArray(parsed.users) || !parsed.users.length) return "The backup has no accounts in it.";
    if (!parsed.users.every((u) => u && typeof u.username === "string" && typeof u.passwordHash === "string")) {
      return "The accounts in the backup aren't in the expected form.";
    }
    if (!parsed.users.some((u) => u.role === "webmaster" && u.status === "active")) {
      return "The backup has no active webmaster account, so restoring it would lock everyone out.";
    }
    if (!Array.isArray(parsed.caveDatabase)) return "The backup has no cave database in it.";
    if (snapshot.narratives) {
      for (const [name, text] of Object.entries(snapshot.narratives)) {
        if (!/^[A-Za-z0-9_-]{1,100}\.json$/.test(name) || typeof text !== "string") return "The narratives in the backup aren't in the expected form.";
      }
    }
    return null;
  }

  // Writes the snapshot's files back. Narratives are replaced exactly (ones
  // added since are removed) unless the backup doesn't include them.
  function apply(snapshot) {
    for (const [key, text] of Object.entries(snapshot.files)) {
      if (text === null || text === undefined || !files[key]) continue;
      writeFileAtomicSync(files[key], text);
    }
    if (snapshot.narratives && narrativeDir) {
      if (!fs.existsSync(narrativeDir)) fs.mkdirSync(narrativeDir, { recursive: true });
      for (const f of fs.readdirSync(narrativeDir)) {
        if (f.endsWith(".json") && !(f in snapshot.narratives)) fs.unlinkSync(path.join(narrativeDir, f));
      }
      for (const [name, text] of Object.entries(snapshot.narratives)) writeFileAtomicSync(path.join(narrativeDir, name), text);
    }
  }

  // Keeps the daily backups from the last 14 days, then one a week for 12
  // weeks; and, separately, the newest 20 manual / uploaded / before-restore
  // backups from the last 90 days - so however many of those are made, they
  // can never push the daily ones out.
  function prune(now = Date.now()) {
    const all = list();
    const keep = new Set();
    const weeks = new Set();
    let others = 0;
    for (const m of all) {
      const age = now - new Date(m.createdAt).getTime();
      if (m.reason === "automatic") {
        if (age <= 14 * DAY_MS) keep.add(m.id);
        else if (age <= 84 * DAY_MS) {
          const week = Math.floor(new Date(m.createdAt).getTime() / (7 * DAY_MS));
          if (!weeks.has(week)) { weeks.add(week); keep.add(m.id); }
        }
      } else if (age <= 90 * DAY_MS && others < 20) {
        others++;
        keep.add(m.id);
      }
    }
    for (const m of all) {
      if (keep.has(m.id)) continue;
      for (const ext of [".json.gz", ".meta.json"]) {
        try { fs.unlinkSync(path.join(dir, m.id + ext)); } catch { /* already gone */ }
      }
    }
  }

  function currentCounts() {
    return capture("now", "").counts;
  }

  return { create, capture, list, read, parse, validate, apply, prune, currentCounts, fileFor };
}

module.exports = { createSnapshotStore, FORMAT };
