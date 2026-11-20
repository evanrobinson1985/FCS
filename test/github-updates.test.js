const { test } = require("node:test");
const assert = require("node:assert/strict");
const gh = require("../lib/github-updates");

const commit = (sha, date, message, parents = 1) => ({
  sha: sha.padEnd(40, "0"),
  commit: { message, committer: { date } },
  parents: Array.from({ length: parents }, () => ({})),
});

test("keeps real changes, newest first, and drops merges, housekeeping and reverted work", () => {
  const out = gh.simplifyCommits([
    commit("a1", "2026-11-14T19:00:00Z", "Add a heatmap to the 3D view\n\nLong technical details\n\nCo-Authored-By: x"),
    commit("a2", "2026-11-14T18:00:00Z", "Merge remote-tracking branch 'origin/x' into x", 2),
    commit("a3", "2026-11-14T17:00:00Z", "Bump site-updates.js cache-busting version"),
    commit("a4", "2026-11-13T17:00:00Z", 'Revert "Cluster cave markers on the Interactive Map"'),
    commit("a5", "2026-11-13T16:00:00Z", "Cluster cave markers on the Interactive Map"),
    commit("a6", "2026-11-12T16:00:00Z", "Initial empty commit"),
    commit("a7", "2026-11-12T15:00:00Z", "Tidy up internals\n\n[no-site-update]"),
  ]);
  assert.deepEqual(out.map((c) => c.items), [["Add a heatmap to the 3D view"]]);
});

test('"Site update:" lines replace the commit title with plain-words items', () => {
  const [c] = gh.simplifyCommits([
    commit("b1", "2026-11-14T12:00:00Z", "Refactor tint mask\n\nSite update: Coloured maps trace better.\nsite update:  Rock between passages is left out. \n"),
  ]);
  assert.deepEqual(c.items, ["Coloured maps trace better.", "Rock between passages is left out."]);
});

test("dates are Florida dates, so evening changes stay on their own day", () => {
  assert.equal(gh.localDate("2026-11-15T02:30:00Z"), "2026-11-14"); // 9:30 pm the 14th in Florida
  assert.equal(gh.localDate("2026-11-15T12:00:00Z"), "2026-11-15");
});

test("one entry per day, linking to that day's newest commit", () => {
  const commits = gh.simplifyCommits([
    commit("c1", "2026-11-14T19:00:00Z", "Second change"),
    commit("c2", "2026-11-14T15:00:00Z", "First change"),
    commit("c3", "2026-11-13T15:00:00Z", "Earlier change"),
  ]);
  const entries = gh.dailyEntries(commits, "owner/repo");
  assert.deepEqual(entries.map((e) => [e.id, e.date, e.title, e.changes]), [
    ["github-2026-11-14", "2026-11-14", "2 changes to the site", ["Second change", "First change"]],
    ["github-2026-11-13", "2026-11-13", "1 change to the site", ["Earlier change"]],
  ]);
  assert.equal(entries[0].url, `https://github.com/owner/repo/commits/${"c1".padEnd(40, "0")}`);
  assert.equal(entries[0].source, "github");
});

test("fetchCommits pages through history and passes the saved ETag", async () => {
  const calls = [];
  const page = (n) => Array.from({ length: n }, (_, i) => commit("p" + i, "2026-11-14T12:00:00Z", "Change " + i));
  const fake = async (url, opts) => {
    calls.push({ url, inm: opts.headers["If-None-Match"] || null });
    const body = url.endsWith("&page=1") ? page(100) : page(7);
    return { ok: true, status: 200, headers: { get: () => '"tag-1"' }, json: async () => body };
  };
  const res = await gh.fetchCommits({ repo: "o/r", ref: "main", etag: '"old"', fetchImpl: fake });
  assert.equal(res.commits.length, 107);
  assert.equal(res.etag, '"tag-1"');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/api\.github\.com\/repos\/o\/r\/commits\?per_page=100&sha=main&page=1$/);
  assert.equal(calls[0].inm, '"old"');

  const unchanged = await gh.fetchCommits({ repo: "o/r", etag: '"x"', fetchImpl: async () => ({ status: 304, ok: false, headers: { get: () => null } }) });
  assert.deepEqual(unchanged, { notModified: true });
  await assert.rejects(gh.fetchCommits({ repo: "o/r", fetchImpl: async () => ({ status: 403, ok: false, headers: { get: () => null } }) }), /403/);
});
