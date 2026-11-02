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

## Membership dues

Webmasters track yearly dues in **Account Management** (the **Dues**
column) and set the price in **Website Management** (the **Membership
Dues** card). Rules:

- A payment makes membership good for one year. Paying early adds the year
  onto the current expiry date.
- Admins and webmasters are exempt.
- Members with no payment recorded show as "No payment recorded". They are
  never treated as overdue, emailed or blocked.
- Each member sees their own status next to "Logged in as" on the
  dashboard.
- **Send dues email** appears only for members whose membership has
  expired.
- The automatic reminder email goes out once per membership year, 30 days
  before expiry (adjustable).
- Blocking expired members is a switch in the Membership Dues card. It is
  **off** by default. When on, an expired member can log in but only sees
  a "pay your dues" page.

Payments are recorded by hand (**Record payment**). PayPal payments are not
picked up automatically.

**Treasurer.** In Account Management, a webmaster can tick **Treasurer**
under any member or admin's role. That person then gets a dues-only view of
Account Management, where they can:

- see every member's account and dues status;
- record and delete payments, and send dues emails;
- set member accounts **Active** or **Inactive**, for example to approve a
  new sign-up once they've paid.

They can't change roles, states or dues settings, create or delete accounts,
or see Security Logs. They also can't change admin, webmaster or their own
accounts. Unticking the box removes the access immediately.

**Daily reminder task (recommended).** The app checks for reminders every
hour while it's running, but Plesk can put it to sleep on quiet days. To
make sure reminders still go out, add a Plesk Scheduled Task:

1. In Plesk, go to **Websites & Domains**, then **Scheduled Tasks**, then
   **Add Task**.
2. Choose **Fetch a URL** and run it **Daily**.
3. Use the URL shown under "Automatic reminders" in the Membership Dues
   card. Keep it private.

Running it more than once a day is harmless, because each reminder is only
ever sent once.

The rules live in `lib/dues.js`; the routes are in `server.js` under
"Membership dues".
