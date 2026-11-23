const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSnapshotStore } = require("../lib/snapshots");

describe("backup retention", () => {
  test("keeps 14 days of dailies, then one a week for 12 weeks, so a burst of edits can't flush them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fcs-snap-"));
    const store = createSnapshotStore({ dir, files: {}, narrativeDir: null, writeFileAtomicSync: (f, c) => fs.writeFileSync(f, c) });
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.parse("2026-11-19T12:00:00Z");
    const make = (daysAgo, reason = "automatic") => {
      const createdAt = new Date(now - daysAgo * DAY).toISOString();
      const id = `${createdAt.replace(/[:.]/g, "-")}-${reason}`;
      fs.writeFileSync(path.join(dir, `${id}.json.gz`), "x");
      fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, createdAt, reason, counts: {}, size: 1 }));
    };
    for (let d = 0; d < 120; d++) make(d);         // a daily backup every day for 4 months
    for (let i = 0; i < 300; i++) make(0.0001 * i, "manual"); // and a burst of 300 manual ones today
    store.prune(now);
    const kept = store.list();
    const dailies = kept.filter((m) => m.reason === "automatic");
    const ages = dailies.map((m) => (now - Date.parse(m.createdAt)) / DAY);
    assert.ok(ages.filter((a) => a <= 14).length >= 14, "the last two weeks of dailies stay");
    assert.ok(Math.max(...ages) > 70, "weekly copies go back about 12 weeks");
    assert.ok(Math.max(...ages) <= 84);
    assert.equal(kept.filter((m) => m.reason === "manual").length, 20, "manual backups are capped on their own");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
