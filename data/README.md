# data/

This directory holds the site's real, private data: the cave database,
the user list, and (once you write anything) timestamped backups of both.
Nothing in here except this file and the two `*.example.json` templates
below is ever committed to git - see the `data/*` rule with `!data/*.example.json`
and `!data/README.md` exceptions in `.gitignore`. That's deliberate: cave
locations are sensitive, and user records contain password hashes and
personal info, so none of it belongs in git history.

## Getting a fresh checkout running

A clone of this repository has no `cave-database.json` or `users.json` -
the server starts fine either way (empty database, nobody able to log in),
but that's not useful for actually trying the site out. Two dummy files are
provided to fix that:

```
cp data/cave-database.example.json data/cave-database.json
cp data/users.example.json data/users.json
```

- **`cave-database.example.json`** - 120 entirely fictional cave records
  (procedurally generated, not real surveys) spread across dozens of real
  Florida counties, in the exact shape the app reads and writes. Every
  record's `notes` field says `SAMPLE DATA` so it's never mistaken for a
  real entry. Once copied to `cave-database.json`, replace it with your
  real survey data - either by re-exporting it into this same JSON shape,
  or by deleting individual sample records via the app and adding real
  ones through the Edit Cave Data tab.

- **`users.example.json`** - one dummy `webmaster` account so you have a
  way to log in at all and approve/manage everyone else from there:

  | Username           | Password           |
  |---------------------|---------------------|
  | `sample-webmaster`  | `ChangeMe123!Now`   |

  **Change this password immediately after your first login** - use the
  "Change Password" button in the dashboard header (top right, next to
  Log Out). This password is sitting in plain sight in git history the
  moment this file is copied into place, so treat it as already
  compromised.

  For a real deployment, prefer creating your own webmaster account
  outright instead of relying on this one - see `scripts/create-user.js`
  and the "Before you deploy" checklist in `SECURITY.md`:
  ```
  node scripts/create-user.js <your-username> <your-password> webmaster <your-email>
  ```
  Then remove the `sample-webmaster` account, either from the Account
  Management tab (logged in as any webmaster) or by deleting its entry
  from `data/users.json` directly.

## Files here

| File | Tracked in git? | Purpose |
|---|---|---|
| `cave-database.json` | No | The live cave database. |
| `users.json` | No | The live user/account list. |
| `pending-submissions.json` | No | Member-submitted proposals awaiting webmaster review. Auto-created as `[]` on first server start - no dummy data needed. |
| `site-config.json` | No | Website Management tab settings (maintenance mode, notification banner). Auto-created with everything off on first server start. |
| `backups/` | No | Automatic timestamped snapshots taken before every write to the files above (see `backupDataFile` in `server.js`). |
| `cave-database.example.json` | **Yes** | Dummy seed data - see above. Every record now carries an explicit `state: "FL"` field (added when multi-state support was introduced - see below), matching what the app itself writes for every new record going forward. |
| `users.example.json` | **Yes** | Dummy seed data - see above. |

## Multi-state support

This started as a Florida-only site; it now hosts any number of states in
the same database, gated by account permissions. Three things changed to
make that possible - relevant if you're looking at `cave-database.json` or
`users.json` directly, or writing a script against either:

- **`../config/states.json`** (tracked in git, *not* in this directory -
  it's reference data, not survey data) is the single source of truth for
  which states/counties exist and what prefix each state's cave IDs use.
  Florida's 67 counties and its single-letter `F` ID prefix are exactly
  what the app has always used (real IDs like `FAL001` are untouched); every
  other state got a 2-letter USPS-code prefix instead (`GA`, `TX`, ...) and
  a generated county list - see `scripts/generate-states-config.js` and
  `scripts/data/README.md` for how that list was built, and re-run that
  script (or hand-edit the config) if a generated county code ever needs
  correcting. The server serves this file's contents publicly at
  `GET /api/states` (no login required - it's the same public county-name
  data every account needs, including at signup before anyone has a token).

- **Cave records** now carry explicit `state` and `county` fields (set by
  the server on every write) instead of relying on the old convention of
  parsing them out of a fixed-offset substring of the cave ID. Any cave
  record written before this feature existed (i.e. every real Florida
  record predating it) is missing these fields; the server and client both
  fall back to parsing them out of the ID for exactly that shape (a single
  `F`, two letters, then digits) - see `resolveCaveStateAndCounty()` in
  `server.js` (and its client-side mirror in `httpdocs/index.html`). New
  code should never rely on that fallback; always read/write the explicit
  fields.

- **User records** gained an `allowedStates` field: `null`/absent means
  unrestricted (always true for `admin` and `webmaster` roles), an array of
  state codes means a member can only see/submit for those states. Set at
  account creation, editable afterward by a webmaster via the Account
  Management tab (`POST /api/change-user-states`).

**Bulk-importing a new state's existing spreadsheet:** a webmaster/admin
can download a per-state `.xlsx` template and upload a filled-in version
from the Cave Database tab's "Import Caves from Spreadsheet" panel (backed
by `GET /api/cave-database/import-template` and
`POST /api/cave-database/import` in `server.js`). Each row is validated and
reported on independently - a bad row doesn't block the rest of the file
from importing - and IDs are assigned the same way as any other new cave
(state-prefixed, numbered sequentially per state+county).
