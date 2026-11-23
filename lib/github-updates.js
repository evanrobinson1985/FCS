// Site Updates from the GitHub commit history.
//
// The Site Updates tab used to list only what someone had written by hand
// into config/site-updates.json, so it fell behind whenever a change went
// out without an entry. This reads the repository's commit history instead
// (the same history the site is deployed from) and turns it into one update
// per day, listing that day's changes.
//
// A commit message can control what members see:
//   - "Site update: <text>" on a line of its own in the message is shown
//     instead of the commit's first line (several such lines give several
//     items). Use it to say a change in plain words.
//   - "[no-site-update]" anywhere in the message leaves the commit out.
// Merge commits, reverts (and the commit each one reverts), and routine
// housekeeping ("Bump ... version", "Initial commit", "WIP ...") are left
// out automatically.
//
// Pure functions only, apart from fetchCommits(); server.js does the caching
// and scheduling.

const DEFAULT_REPO = "evanrobinson1985/FCS";
const TIME_ZONE = "America/New_York";
const MAX_PAGES = 5; // 100 commits a page

const HOUSEKEEPING = /^(merge\b|wip\b|initial (empty )?commit\b|bump\b.*\b(version|cache))/i;
const REVERT = /^Revert "(.+)"\s*$/;
const SITE_UPDATE_LINE = /^\s*site update:\s*(.+?)\s*$/gim;
const SKIP_MARK = /\[no-site-update\]/i;

// "YYYY-MM-DD" in Florida time, so a change made in the evening isn't
// listed under the next day.
function localDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Reduces the GitHub API's commit objects to what is kept and shown:
// [{ sha, date, items: [text, ...] }], newest first. Commits that should not
// appear are dropped here.
function simplifyCommits(apiCommits) {
  if (!Array.isArray(apiCommits)) return [];
  const commits = apiCommits
    .filter((c) => c && typeof c.sha === "string" && c.commit && typeof c.commit.message === "string")
    .map((c) => ({
      sha: c.sha,
      when: (c.commit.committer && c.commit.committer.date) || (c.commit.author && c.commit.author.date) || "",
      merge: Array.isArray(c.parents) && c.parents.length > 1,
      message: c.commit.message,
    }));

  // A revert cancels the commit it reverts: leave both out, so members never
  // read about a change that was taken back
  const reverted = new Set();
  commits.forEach((c) => {
    const m = REVERT.exec(c.message.split("\n")[0]);
    if (m) reverted.add(m[1]);
  });

  const out = [];
  for (const c of commits) {
    const subject = c.message.split("\n")[0].trim();
    if (!subject || c.merge || HOUSEKEEPING.test(subject) || REVERT.test(subject)) continue;
    if (reverted.has(subject) || SKIP_MARK.test(c.message)) continue;
    const date = localDate(c.when);
    if (!date) continue;
    const notes = [];
    let m;
    SITE_UPDATE_LINE.lastIndex = 0;
    while ((m = SITE_UPDATE_LINE.exec(c.message))) notes.push(m[1]);
    out.push({ sha: c.sha, date, when: c.when, items: (notes.length ? notes : [subject]).map((t) => t.slice(0, 500)) });
  }
  out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
  return out.map(({ when, ...rest }) => rest);
}

// One Site Updates entry per day, in the same shape as the hand-written
// entries in config/site-updates.json, plus where it came from.
function dailyEntries(commits, repo) {
  const byDate = new Map();
  for (const c of commits || []) {
    if (!byDate.has(c.date)) byDate.set(c.date, []);
    byDate.get(c.date).push(c);
  }
  const entries = [];
  for (const [date, list] of byDate) {
    const changes = [];
    list.forEach((c) => c.items.forEach((t) => { if (!changes.includes(t)) changes.push(t); }));
    entries.push({
      id: `github-${date}`,
      date,
      title: changes.length === 1 ? "1 change to the site" : `${changes.length} changes to the site`,
      changes,
      source: "github",
      // the newest commit of the day: its history page lists this day's changes first
      url: `https://github.com/${repo || DEFAULT_REPO}/commits/${list[0].sha}`,
    });
  }
  return entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// Fetches the commit history (newest first, up to MAX_PAGES * 100 commits).
// `etag` is the one returned last time: when nothing has changed GitHub
// answers 304, which doesn't count against its rate limit, and this
// returns { notModified: true }.
async function fetchCommits({ repo, ref, token, etag, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fcs-site-updates",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const base = `https://api.github.com/repos/${repo || DEFAULT_REPO}/commits?per_page=100` + (ref ? `&sha=${encodeURIComponent(ref)}` : "");
  const all = [];
  let firstEtag = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const h = Object.assign({}, headers);
    if (page === 1 && etag) h["If-None-Match"] = etag;
    const res = await doFetch(`${base}&page=${page}`, { headers: h, signal: AbortSignal.timeout(15000) });
    if (page === 1 && res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo || DEFAULT_REPO}`);
    if (page === 1) firstEtag = res.headers.get("etag");
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error("GitHub sent something other than a commit list");
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return { commits: all, etag: firstEtag };
}

module.exports = { DEFAULT_REPO, localDate, simplifyCommits, dailyEntries, fetchCommits };
