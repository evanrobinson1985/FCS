# Security hardening notes

This document explains what changed, why, and what you still need to do
before this goes live. Read the "Before you deploy" checklist at the bottom
first if you're in a hurry.

## The two problems you reported

### 1. The cave database was exposed before login

Two things caused this, and both are fixed:

- `httpdocs/index.html` loaded the entire database with
  `<script src="cave-database.js"></script>` - a plain static file anyone
  could request, logged in or not, and read straight out of the page
  source or the Network tab. **This line has been removed.**
- Even the "proper" API route, `GET /api/cave-database`, had no login check
  at all, and the client called it automatically on every page load
  (`DOMContentLoaded`), before any authentication happened.

Fixes:
- The cave database now lives in `data/cave-database.json`, a directory
  that is **never** registered with `express.static` - nothing under
  `data/` can be requested by a browser no matter what URL is guessed.
- `GET /api/cave-database` (and every other API route that touches cave
  data, submissions, narratives, or cave maps) now requires a valid,
  unexpired login token. An anonymous request gets `401 Unauthorized`, not
  data.
- The client only fetches the database after a successful login (and once
  on page load, in case a still-valid token from an earlier session is
  present - that call simply fails silently for a logged-out visitor).
- Map imagery (GeoTIFFs, shapefiles, hillshade tiles) had the same problem
  - served as plain static files with no auth check, and with a wildcard
  `Access-Control-Allow-Origin: *` header on top. Both are fixed the same
  way.

There was also a second, more serious bug hiding underneath: the old
"save the database" code stored it as a hand-written JavaScript file
(`const caveDatabase = [...]`) and read it back with `new Function(...)` -
essentially `eval`. The code that wrote values into that file never
escaped quote characters, so a cave name or note containing a `"` could
break out of its string and inject arbitrary JavaScript that would then
**execute** the next time the server started or reloaded the database.
That's a stored remote-code-execution bug, not just a data leak. The
database is now stored as plain JSON (`JSON.parse`/`JSON.stringify`), which
has no such ambiguity, and the write endpoints are restricted to
admin/webmaster accounts.

### 2. Data in transit

The app itself now does everything in its power to keep traffic encrypted:

- **HSTS** is sent on every response (via `helmet`), telling browsers to
  never downgrade this site to plain HTTP again once they've seen it once.
- In production (`NODE_ENV=production`), the server redirects any request
  that reaches it over plain HTTP to the `https://` URL instead.
- A restrictive Content-Security-Policy is set to reduce what an XSS bug
  (see below) could do even if one slipped through.

**However: this app cannot terminate TLS by itself in any deployment where
it's the only thing running.** Node is listening on a plain TCP port
(`PORT`, default 3000); something has to sit in front of it holding the
actual certificate and doing the TLS handshake. That's either:

- A reverse proxy (nginx, Caddy, Apache) in front of Node, or
- Your hosting platform's built-in HTTPS (if this app is deployed inside
  Plesk - which the `httpdocs/` folder name suggests - Plesk's
  **Websites & Domains → SSL/TLS Certificates** panel can issue a free
  Let's Encrypt certificate and terminate TLS for you automatically; make
  sure "Permanent SEO-safe 301 redirect from HTTP to HTTPS" is turned on
  there too, in addition to this app's own redirect).

Minimal nginx example if you're managing the proxy yourself:

```nginx
server {
    listen 443 ssl http2;
    server_name fcs.caves.org;

    ssl_certificate     /etc/letsencrypt/live/fcs.caves.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fcs.caves.org/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
server {
    listen 80;
    server_name fcs.caves.org;
    return 301 https://$host$request_uri;
}
```

The `X-Forwarded-Proto https` line is what this app's own HTTP→HTTPS
redirect (and `app.set("trust proxy", 1)`) relies on - without a proxy
setting that header, the app has no way to know the original request was
already secure.

## Everything else that was fixed

- **Every sensitive API route now requires login.** Before, `/api/users`,
  `/api/change-user-role`, `/api/delete-user`, `/api/security-logs`,
  submission approval/rejection, cave-map uploads/deletes, and the cave
  database write endpoints had no authentication at all - anyone who found
  the URL could call them directly with curl. They now require a valid
  session token, and the admin-only ones (`webmaster` role) are further
  restricted by role.
- **Passwords are hashed properly, everywhere.** Login used to compare
  plaintext (`user.password !== password`), while the registration form
  hashed with bcrypt into a different field - two inconsistent, partially
  broken code paths. Every account-creation path now hashes with
  `bcrypt` (cost factor 12) into `passwordHash`, and login verifies with
  `bcrypt.compare`. Plaintext passwords are never written to disk.
- **No hardcoded JWT secret.** The server used to fall back to the literal
  string `"super-secret-key"` if `JWT_SECRET` wasn't set - meaning anyone
  could forge a valid admin login token for a default install. The server
  now refuses to start without a real `JWT_SECRET` (32+ characters) in the
  environment.
- **Login brute-force protection.** Rate limiting on `/api/login`,
  `/register-member`, `/api/create-account`, `/api/forgot-password`,
  `/api/verify-2fa`, `/api/resend-2fa`, and `/api/change-password` (10
  requests / 15 minutes per IP), plus a per-account lockout after 5 failed
  attempts (passwords and, separately, 2FA codes).
- **Optional email-based two-factor authentication.** Any member can turn
  it on for their own account (a button in the dashboard header, or
  `POST /api/toggle-2fa`). Once enabled, a correct password at `/api/login`
  doesn't issue a session token yet - it emails a 6-digit code (logged to
  the console instead, in dev, the same way password reset links are) and
  returns a short-lived (10 minute) "pending" token that's only good for
  `/api/verify-2fa`/`/api/resend-2fa`. `authenticateToken` explicitly
  rejects that pending token everywhere else, so it can't be used to skip
  the code step on any real route even if it leaked. Turning 2FA back off
  requires re-entering the current password, so a hijacked session token
  alone can't silently disable it.
- **New self-registered accounts start `pending`**, not active - a
  webmaster has to approve them in Account Management before they can log
  in.
- **Stored XSS in narratives.** Narrative HTML (written with the Quill rich
  text editor) is now run through `sanitize-html` before being saved,
  stripping `<script>`, event-handler attributes (`onerror=`, etc.), and
  `javascript:` URLs, so a malicious narrative can't run script in every
  other member's browser when they view it.
- **Authorization bypasses via client-supplied identity.** Several routes
  (`save-narrative`, `delete-narrative`, `delete-narrative-image`,
  `POST`/`PATCH /api/pending-submissions`) trusted a `user`/`currentUser`/
  `submittedBy`/`approvedBy`/`rejectedBy` field sent in the request body to
  decide who was allowed to edit, delete, submit, or approve what - meaning
  anyone could impersonate anyone else just by changing that field. These
  now derive identity from the verified login token instead.
- **Path traversal.** Every route that takes a filename from the URL or
  request body (cave map downloads, narrative image downloads, SQLite
  hillshade tiles, etc.) now runs it through `path.basename()` (or a strict
  allowed-characters check for cave IDs) before touching the filesystem, so
  a filename like `../../../../etc/passwd` can't escape the intended
  directory.
- **File upload restrictions.** Narrative image uploads are now limited to
  actual image MIME types, capped at 10MB, and given a generated filename
  instead of trusting the client's filename directly.
- **CORS.** Replaced the wildcard `Access-Control-Allow-Origin: *` on map
  files with an allow-list (`ALLOWED_ORIGINS` in `.env`) applied
  consistently across the whole app.
- **Security headers** via `helmet`: Content-Security-Policy, HSTS,
  X-Content-Type-Options, X-Frame-Options, etc.
- Fixed a route-registration bug where `/api/cave-maps/validate/:type/:filename`
  was accidentally defined *inside* the `/api/cave-maps/list` handler, so a
  duplicate route handler was registered on every single call to `/list` -
  an unbounded handler leak. It's now registered once, at startup.
- Fixed `reloadCaveDatabase()` being called in four places without ever
  being defined - a `ReferenceError` waiting to crash the process the first
  time anyone edited a cave record.

## Follow-up pass: regressions from the hardening itself, plus a few more bugs

A real-browser test (Playwright, since curl can't see CSP violations, broken
`onclick` handlers, or 401s on `<img>` tags) turned up issues the first pass
missed - some caused by the hardening itself, some pre-existing:

- **Every inline `onclick="..."`/`onchange="..."` handler in the app was
  silently dead.** `helmet`'s default CSP sets `script-src-attr: 'none'`,
  a *separate* directive from `script-src` that specifically blocks inline
  event-handler attributes - and this app uses dozens of them. The browser
  just logs a console warning and does nothing, so this was invisible to
  every curl-based test in the first pass. Fixed by explicitly setting
  `scriptSrcAttr: ["'unsafe-inline'"]` (server.js).
- **Cave photos and map previews 401'd after login**, for the same reason
  in reverse: `<img src>`, `<iframe src>`, and download links have no way to
  carry the `Authorization` header `fetch()` uses, so gating `/cave-pictures`,
  `/cave-maps`, and `/cave-maps-collection` behind that header broke every
  actual display of an image or map. Fixed with a `?token=` query-parameter
  fallback in `authenticateToken` (server-side) plus a `withAuthToken()`
  helper (client-side) applied at every place those URLs get built. Session
  tokens are stripped back out of narrative HTML/image URLs before saving
  (`stripAuthToken()`) so they never end up persisted to disk.
- **`/cave-pictures` images were reachable without logging in at all**,
  despite the auth-gated mount added for them - a second, general
  `express.static(httpdocs)` mount was registered *before* it, and Express
  matches static file middleware in registration order, not by path
  specificity, so the general mount served files out of the subdirectory
  before the auth check ever ran. Fixed by reordering the two mounts.
- **The CSP sent `upgrade-insecure-requests` even in local development**,
  which tells the browser to rewrite every `http:` request the page makes
  (including its own same-origin API calls) to `https:` - breaking the app
  entirely when run locally without TLS. Now conditional on
  `NODE_ENV=production`.
- **The account-creation password minimum didn't match between client and
  server** (client checked 8 characters, server required 10) - an 8- or
  9-character password would pass the form's validation and then fail with
  a confusing server error. Client now matches the server's 10.
- **Two buttons called functions that didn't exist**: "Download Updated
  Database" called `downloadUpdatedCaveData()`, which was never defined
  (only a differently-named helper that takes a data argument existed);
  "Upload Maps" called `uploadCaveMaps()`, which didn't exist at all, and
  its server endpoint was an unfinished stub that always returned 501. Both
  are now implemented end-to-end (client function + working multer-based
  upload route, extension-validated and path-traversal-safe).
- **Several `fetch()` calls and one `<img>` hardcoded the production
  domain** (`https://fcs.caves.org/...`) instead of using a relative path,
  so narrative save/delete/upload, the caves-with-narratives loader, and
  the cave-maps list all silently failed on any other host (local dev,
  staging, or a future domain change). Normalized to relative paths.
- A narrative's "attach uploaded images" logic used the same hardcoded-
  domain string to detect which `<img>` tags were the app's own uploads,
  so it silently produced an empty image list everywhere but production.
  Made origin-agnostic (checks the path, not the full URL).

## What this pass did *not* do

Being upfront about the tradeoffs and what's left:

- **CSP still allows `'unsafe-inline'`** for scripts and styles. This app's
  11,000-line `index.html` has extensive inline `<script>` blocks and
  `onclick=` handlers throughout; a strict CSP would break the app outright
  without a much larger refactor to move all of that into external files
  and wire up nonces. The CSP still meaningfully restricts which *external*
  script origins can load, which is the main defense against a typical
  XSS payload trying to load attacker-controlled JavaScript.
- **`img-src`/`connect-src` in the CSP are broad** (`https:`), because the
  interactive map pulls tiles from many different geographic data
  providers (Esri, USGS National Map, Stamen, etc.) and enumerating every
  one precisely risked silently breaking map layers that couldn't be
  tested in this environment. Worth tightening once you have a full list
  of tile providers you actually use.
- **Email verification on signup is still a stub** - `isEmailVerified` is
  set but nothing actually sends or checks a verification email. Password
  reset, however, is now real: `/api/forgot-password` and
  `/api/reset-password` issue a single-use, 1-hour, SHA-256-hashed token
  and email the reset link via SMTP (configure `SMTP_*` in `.env`); without
  SMTP configured it logs the link to the server console instead, which is
  fine for local development but not for production.
- This review covered the application code you provided. It did not
  include a dependency vulnerability scan (`npm audit`) or a penetration
  test - run `npm audit` after `npm install` and periodically thereafter.
- **Multi-state support (cave maps/narratives/pictures aren't state-scoped).**
  When per-account `allowedStates` restrictions were added, every cave-data
  *route* (`/api/cave-database`, pending/approved submissions) was scoped
  to a member's granted states. Uploaded cave maps, narratives, and cave
  pictures were not, because none of those are stored keyed by state or
  county in the first place - they're looked up by filename/cave ID, not
  filtered by a list endpoint. A member scoped to one state can't discover
  another state's map/narrative/picture filenames through the UI (nothing
  links to them), but if they already know or guess a filename/cave ID
  belonging to a state they aren't granted, the file itself isn't blocked.
  This doesn't expose the cave database (locations, county assignments,
  submission data) itself, only whatever incidental detail a map file name
  or narrative text might contain. Closing this gap fully would mean
  restructuring how those three file types are stored (keyed by
  state/county, with the same per-request `allowedStates` check the
  database routes already do) - worth doing before this app is used for
  states whose survey communities shouldn't see each other's supplementary
  files, but out of scope for the pass that added multi-state support.

## Before you deploy

1. `npm install` (pulls in the new dependencies: `helmet`, `cors`,
   `express-rate-limit`, `sanitize-html`, `dotenv`).
2. Copy `.env.example` to `.env` and fill in a real `JWT_SECRET`
   (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`),
   `NODE_ENV=production`, and `ALLOWED_ORIGINS`.
3. Restore your real `data/cave-database.json` (an array of cave objects,
   same shape as before - just JSON now instead of a `.js` file) and
   `data/users.json` into the `data/` directory. Both are gitignored and
   were intentionally left out of this pass. If you don't have real data
   yet and just want the site running to try it out, copy the dummy
   templates instead (`cp data/cave-database.example.json
   data/cave-database.json`, same for `users.example.json`) - see
   `data/README.md` for what's in them (the user template is an example
   record only; it has no password and can't log in).
   Swap in your real files whenever you're ready; nothing under `data/`
   except those two `.example.json` templates is ever committed.
4. Make sure something in front of Node is terminating real TLS (see
   "Data in transit" above) before this touches the public internet.
5. Create at least one `webmaster` account so you have a way to approve
   everyone else's pending signups - the `register-member`/`create-account`
   flows can't grant that role. Use the bundled script rather than editing
   `data/users.json` by hand, so the password is bcrypt-hashed correctly:
   ```
   node scripts/create-user.js <username> <password> webmaster <email>
   ```
   Running it again for the same username updates that account (new
   password/role/email) instead of creating a duplicate - handy for a
   password reset from the command line if a webmaster ever gets locked
   out. Whoever logs in with it can change the password themselves
   afterward from the dashboard header ("Change Password", backed by
   `POST /api/change-password` - requires the current password, works for
   any role, not just webmaster).

## Security review, November 2026

A full review of the server routes, login and session handling, uploads,
page rendering (cross-site scripting), headers, dependencies and member data
exposure. Fixed in this pass:

- **Email links built from the request's Host header.** Password-reset and
  verification links fell back to the Host header when `ALLOWED_ORIGINS` was
  unset, so a forged Host could send a member a link to an attacker's site
  carrying their reset token. Links now always use the configured address.
- **Logging out didn't end the session.** A copied token kept working for up
  to 8 hours. Each login now has a session id; logging out revokes it (both
  the session token and its view-only token), recorded on disk.
- **Two-factor sign-in was optional for admins and webmasters.** They now
  always get an emailed code at login (once email is configured) and can't
  turn it off.
- **Sign-up revealed whether an email address had an account.** It now gives
  the same reply either way and emails the existing owner instead.
- **Data replies could be cached.** Everything under `/api/` and the narrative
  routes is sent with `Cache-Control: no-store`, so the cave database isn't
  left in a browser's disk cache.
- **The Content-Security-Policy allowed images and fetches to any HTTPS
  site.** `img-src` and `connect-src` now list only the map and data services
  the pages use, so an injected script would have nowhere to send data.
  Narratives can no longer embed images hosted elsewhere (also a privacy leak:
  that site saw every member who opened the narrative).
- **PDF.js 3.11 (CVE-2024-4367).** Already blocked by the CSP (no
  `unsafe-eval`); the Map Georeferencer now also turns off PDF.js's eval path.
- **JWT algorithm** pinned to HS256 on every verify.
- **Map uploads** no longer silently replace an existing file.
- **Webmaster and admin controls** (Account Management, Website Management,
  Upload Cave Maps) are sent only to accounts the server confirms, and the
  page reads the role from the signed token, not browser storage.

Checked and found sound: every route's role gate; narrative HTML
sanitizing; escaping in the page (including the security log, the usual way
to attack a webmaster); photo uploads (type from the file's bytes, random
names); password reset (hashed, single-use, 1-hour tokens that end old
sessions); 2FA code attempt limits; login rate limiting and lockout; no shell
commands anywhere; no self-update feature; `npm audit` clean for the running
server.

Still open (need a decision or a larger change):

- **Any approved member can download the whole cave database** (landowner
  details included, by decision). Since this review, every download is logged
  and every export is watermarked (see "Download log and export watermarks"
  below), so a leaked export can be traced. The raw database copy each
  browser downloads at login is logged but can't carry a watermark, so a
  member who copies it out of the browser is only identifiable as one of the
  members who downloaded it. A per-account fingerprint in that copy (tiny,
  harmless differences in the coordinates each account receives) would close
  that gap; not done.
- **`'unsafe-inline'` scripts and session tokens in `sessionStorage`.** If an
  injection bug were ever found, script could run and read the token. The
  fix is moving the page's inline scripts into files (then dropping
  `'unsafe-inline'`) and moving sessions to HttpOnly cookies with CSRF
  protection.
- **Two-factor is an emailed code**, so whoever controls an admin's email
  controls the account. An authenticator-app option (TOTP) would be stronger.
- **SheetJS (`xlsx`) 0.18.5** (dev-only: import scripts and the bulk-import
  screen) has known prototype-pollution and ReDoS issues; the fixed release
  is published on cdn.sheetjs.com, not npm.
- **PDF.js** should be upgraded to 4.x.
- **Hosting**: server patching, Plesk panel access, SSH, TLS settings and
  off-site encrypted backups are outside the code, and an independent
  penetration test of the deployed site is the real proof.

## Download log and export watermarks

Every time cave data leaves the site it's recorded in `data/download-log.json`
(newest 20,000 entries): who, when, IP address, browser, what and how many
caves. That covers each copy of the cave database a browser downloads (one per
login), each export (CSV, Excel, GPX, the `.js` database file, a Cave
Profile), each map file sent in full, and each backup.

Exports are registered with the server first (`POST /api/exports`), which logs
them and returns an Export ID; the page then writes "Exported for <name>
(<username>) on <date>. Export ID <id>. Do not share..." into the file - the
first line of a CSV plus an Export ID column on every row, an "About this
export" sheet plus the column and the file properties in Excel, the metadata
plus every waypoint in GPX, a header in the `.js` and profile files - and puts
the ID in the file name. The page won't make an export the server didn't
register. Webmasters look an Export ID (or a username or IP address) up in
Website Management > Data Downloads, which also totals each account's
downloads over the last 30 days. Members are told by the export buttons that
exports are marked and logged.

## Security review, second pass (November 2026)

Fixed:

- **One anonymous request could freeze the site for ~30 seconds.** Every
  route after the global JSON parser accepted 10 MB bodies before any login
  check, and one attack-detection pattern (`<[^>]*\bon...=`) was quadratic on
  text full of `<`. A 4 MB body of such fields took 29 s of CPU on the
  single-threaded server. The pattern is now bounded, the body scan reads at
  most 100,000 characters per request, and JSON bodies are capped at 100 KB
  except for the two signed-in routes that need more (saving the cave
  database; a narrative with pasted pictures), which parse their own 10 MB
  bodies after the login and role checks. Oversized or malformed bodies get
  413 / 400 instead of a 500.
- **The setup instructions published a webmaster password** (a sample
  webmaster account in `data/users.example.json`, with its password printed in
  `data/README.md`, which told people to copy the file into place). The
  credentials are removed from the instructions and the example file (now an
  inactive member record with no password), and the server refuses that
  password at login for any account, since it stays in the git history. The
  instructions say to create your own webmaster with `scripts/create-user.js`.
- **The download log could be flooded** to push an export record out of it.
  Exports and backups are now kept ahead of routine entries, and each account
  is limited to 60 cave database downloads an hour and 50 exports a day.
- **Hillshade routes** leaked their database handle when something failed and
  sent internal error text (file paths) to the browser; now closed on every
  path, with a generic message. Tiles are `Cache-Control: private`.

Checked and found sound in this pass: the Map Georeferencer, Cave Jump and
maintenance pages (escaped output); every file path built from a cave ID
(`isSafeRecordId`); the hillshade SQL (bound parameters); the automatic
restriction never locking out a webmaster; members seeing only their own
feedback; the "who's online" list carrying no IP addresses; no secrets in the
git history (only blank placeholders in `.env.example`).

To check once the site is deployed: open `/api/debug-headers` as a webmaster
and confirm `ip` is your own public address. If it's `127.0.0.1` or the
server's own address, Plesk's proxy chain has an extra hop and
`app.set("trust proxy", 1)` needs adjusting - otherwise rate limits, lockouts
and logs treat every visitor as one address.
