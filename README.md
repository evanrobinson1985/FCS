# florida_cave_survey
Webhosting For FCS data

## Setup

See `SECURITY.md` ("Before you deploy") for the full setup checklist, and
`data/README.md` for the dummy seed data (a sample cave database and a
sample webmaster login) a fresh checkout needs to actually run.

## Posting a site update ("What's new")

After logging in, each account sees a "What's new" card listing any site
updates it hasn't seen yet. Closing the card records that, so it only comes
back when there's a newer update. The **Site Updates** tab shows the full
timeline.

Updates live in `config/site-updates.json`, which deploys with the code.
To announce a change, add an entry to the top of that file:

```json
{
  "id": "2026-12-01-short-name",
  "date": "2026-12-01",
  "title": "What changed, in a few words",
  "changes": ["One line per change, written for site users."]
}
```

`id` must be unique, and `date` must be `YYYY-MM-DD`; `npm test` checks
both.

Requests and bug reports sent with the **Request a feature** and **Report a
bug** buttons on the Site Updates tab are saved in `data/feedback.json`
(private, backed up like the other data files) and emailed to every active
webmaster. Webmasters manage them on the same tab.
