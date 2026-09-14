# Florida Cave Survey — Android app

A native Android (Kotlin + Jetpack Compose) client for the Florida Cave
Survey webmaster portal. It talks to the **existing, unmodified** `server.js`
REST API in the repo root — nothing under `httpdocs/` or `server.js` was
changed to build this; the website keeps running exactly as it did before.

## What it does

Full feature parity with the web portal, against the same API:

- **Auth**: login, email 2FA, forgot/reset password, self-registration,
  change password, toggle 2FA, session stored in `EncryptedSharedPreferences`.
- **Cave database**: browse/search/filter by state, cave detail view,
  direct edit (admin/webmaster) or propose-an-edit submission (members).
- **Map**: cave locations on a map, with the server's SQLite-hillshade
  tile layers selectable as an overlay.
- **Narratives**: per-cave write-ups with photo upload/download, edit and
  delete (own narratives, or any as a moderator).
- **Admin/webmaster tools**: user management (roles, allowed states,
  activate/deactivate/delete), pending-submission review, site
  configuration (maintenance mode, banner, read-only mode, login lockout
  policy, auto-update), security log, cave map/geotiff/shapefile upload.

## Project layout

```
android/
  app/src/main/java/com/floridacavesurvey/android/
    data/            Retrofit API interface, models, repositories, token storage
    ui/               Compose screens + ViewModels, one package per feature area
```

## Two build flavors

This is one codebase, built into two separate, separately-installable apps
(different `applicationId`/name/icon so they sit side by side on a phone):

| Flavor | App name | Who it's for | Login screen |
|---|---|---|---|
| `general` | FL Cave Survey | any member | username/password (as documented above) |
| `webmaster` | FCS Webmaster | one specific account | "Continue with Google" first, username/password still available underneath as a fallback |

Both flavors have 100% of the same feature set once logged in — `webmaster`
only differs in how you get in. Password login is never removed from
either.

## Building

Standard Gradle/AGP project:

```
cd android
./gradlew assembleGeneralDebug      # the regular app
./gradlew assembleWebmasterDebug    # the passwordless build, see below
```

Requires an Android SDK (`ANDROID_HOME` set, or `local.properties` with
`sdk.dir=...`) — this was scaffolded in a sandboxed environment with no
access to `dl.google.com`, so the build has **not** been run/verified
end-to-end here. Open the `android/` folder in Android Studio and it will
prompt to install any missing SDK components.

By default the app points at `https://floridacavesurvey.org/`. Override at
build time for a local dev server:

```
./gradlew assembleGeneralDebug -PapiBaseUrl=http://10.0.2.2:3000/
```

(`10.0.2.2` is the Android emulator's alias for the host machine; cleartext
HTTP is allowed only for that host and `localhost`, see
`app/src/main/res/xml/network_security_config.xml`.)

## Google sign-in setup (webmaster flavor)

Passwordless login is **off by default on both the app and the server** —
building/installing the `webmaster` flavor without doing this setup just
gets you the same username/password screen as the `general` flavor. Two
things need to exist before it works, and neither can be done from here
since both require your own Google account interactively:

**1. Google Cloud OAuth client (one-time, at [console.cloud.google.com](https://console.cloud.google.com)):**
1. Create or pick a project → *APIs & Services* → *Credentials*.
2. Set up the OAuth consent screen if you haven't already (Testing mode is
   fine — only your own account ever signs in).
3. Create an OAuth client ID of type **Android**: package name
   `com.floridacavesurvey.android.webmaster`, SHA-1 of whatever certificate
   you sign the app with (`keytool -list -v -keystore your.keystore` — for
   a debug build, `~/.android/debug.keystore`, password `android`).
4. Create a **second** OAuth client ID of type **Web application** (no
   redirect URIs needed). Copy its Client ID — that's the one the app and
   server both need, *not* the Android client's own ID (Credential Manager
   uses the Web client as the token's audience).

**2. Wire the Web client ID into both sides:**

- **Server** (`.env`, see `.env.example` at the repo root):
  ```
  GOOGLE_OAUTH_CLIENT_ID=<the Web client ID from step 4>
  GOOGLE_WEBMASTER_EMAIL=<your Google account email>
  ```
  `GOOGLE_WEBMASTER_EMAIL` must exactly match the `email` field of an
  existing, active user in `data/users.json` whose `role` is `"webmaster"`
  — restart the server after setting these.
- **App**, at build time:
  ```
  ./gradlew assembleWebmasterDebug -PgoogleWebClientId=<the same Web client ID>
  ```

Until both are set, `/api/google-login` answers `503` and the button, if
shown, will surface that as an error rather than doing anything unsafe.

**How it actually logs you in:** tapping "Continue with Google" is only
the first factor — it replaces the password check, not the rest of login.
The server always emails a 6-digit verification code afterward (reusing
the site's existing email 2FA flow) before issuing a real session, so
signing in this way still requires two things: your Google session on the
device, and access to your email.

## Notes / known gaps

- The narrative editor captures plain text (wrapped into `<p>` tags) rather
  than full rich-text HTML — the server's `sanitize-html` allowlist supports
  much more (bold, links, embedded video, etc.); a richer editor could be
  added later without any API changes.
- Cave-database import (`.xlsx` upload), the import template download, and
  the git-based update/backup tools are modeled in the API layer
  (`ApiService`) but don't have a dedicated screen yet — low priority
  webmaster-only deploy tooling per the API reference.
- Deep-linking a password-reset email link straight into the app isn't
  wired up; the reset screen instead lets the user paste the token from the
  email manually.
