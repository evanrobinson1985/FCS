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

## Building

Standard Gradle/AGP project:

```
cd android
./gradlew assembleDebug
```

Requires an Android SDK (`ANDROID_HOME` set, or `local.properties` with
`sdk.dir=...`) — this was scaffolded in a sandboxed environment with no
access to `dl.google.com`, so the build has **not** been run/verified
end-to-end here. Open the `android/` folder in Android Studio and it will
prompt to install any missing SDK components.

By default the app points at `https://floridacavesurvey.org/`. Override at
build time for a local dev server:

```
./gradlew assembleDebug -PapiBaseUrl=http://10.0.2.2:3000/
```

(`10.0.2.2` is the Android emulator's alias for the host machine; cleartext
HTTP is allowed only for that host and `localhost`, see
`app/src/main/res/xml/network_security_config.xml`.)

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
