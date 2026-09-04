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
| `backups/` | No | Automatic timestamped snapshots taken before every write to the two files above (see `backupDataFile` in `server.js`). |
| `cave-database.example.json` | **Yes** | Dummy seed data - see above. |
| `users.example.json` | **Yes** | Dummy seed data - see above. |
