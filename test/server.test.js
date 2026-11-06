// Server-side test suite. Run with `npm test` (node --test test/).
//
// Every mutable data path (users, cave database, submissions, narratives,
// cave maps, cave pictures) is redirected into a throwaway temp directory
// before server.js is ever required, via the env-var overrides added to
// server.js for exactly this purpose - these tests can never read or write
// real application data.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");
const XLSX = require("xlsx");

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fcs-test-"));

process.env.JWT_SECRET = "test-jwt-secret-not-for-real-use-0123456789abcdef";
process.env.DATA_DIR = path.join(TEST_ROOT, "data");
process.env.SUBMISSIONS_FILE = path.join(TEST_ROOT, "pending-submissions.json");
process.env.NARRATIVE_DIR = path.join(TEST_ROOT, "narratives");
process.env.CAVE_MAPS_DIR = path.join(TEST_ROOT, "cave-maps");
process.env.CAVE_PICTURES_DIR = path.join(TEST_ROOT, "cave-pictures");
process.env.SITE_UPDATES_FILE = path.join(TEST_ROOT, "site-updates.json");
fs.writeFileSync(
  process.env.SITE_UPDATES_FILE,
  JSON.stringify([
    { id: "older", date: "2026-01-01", title: "Older update", changes: ["a"] },
    { id: "newest", date: "2026-03-01", title: "Newest update", changes: ["b", "c"] },
    { id: "bad-date", date: "March", title: "Malformed", changes: [] },
    { id: "middle", date: "2026-02-01", title: "Middle update", changes: [] },
    {
      id: "webmaster-secret",
      date: "2026-04-01",
      title: "Webmaster secret update",
      changes: ["x"],
      webmasterOnly: true,
    },
  ])
);
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "http://localhost:3000";

const request = require("supertest");
const app = require("../server");

const WEBMASTER_PASSWORD = "WebmasterPass123!";
const MEMBER_PASSWORD = "MemberPass123!";

function usersFilePath() {
  return path.join(process.env.DATA_DIR, "users.json");
}

async function seedUser({ username, password, role, status = "active", allowedStates = [] }) {
  const file = usersFilePath();
  const users = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  users.push({
    id: `${role}-${username}`,
    username,
    email: `${username}@example.com`,
    passwordHash: await bcrypt.hash(password, 10),
    fullName: username,
    role,
    status,
    allowedStates,
    created: new Date().toISOString(),
    lastLogin: null,
    loginAttempts: 0,
    isEmailVerified: true,
    loginIPs: [],
  });
  fs.writeFileSync(file, JSON.stringify(users, null, 2));
}

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  assert.equal(res.status, 200, `login failed for ${username}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

before(async () => {
  await seedUser({ username: "webmaster1", password: WEBMASTER_PASSWORD, role: "webmaster" });
  // Florida access (matching every pre-multi-state test's implicit
  // assumption that member1 operates in a Florida-only world) plus Georgia
  // (used by the non-Florida-state submission test below). Tests that
  // specifically exercise state *restriction* use their own dedicated,
  // narrowly-scoped user instead - see "allowed states" describe block.
  await seedUser({ username: "member1", password: MEMBER_PASSWORD, role: "member", allowedStates: ["FL", "GA"] });
});

after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("login", () => {
  test("rejects missing credentials", async () => {
    const res = await request(app).post("/api/login").send({});
    assert.equal(res.status, 400);
  });

  test("rejects a wrong password with a generic error (no user-enumeration hint)", async () => {
    const res = await request(app)
      .post("/api/login")
      .send({ username: "webmaster1", password: "wrong-password" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Invalid username or password");
  });

  test("rejects a username that doesn't exist with the same generic error", async () => {
    const res = await request(app)
      .post("/api/login")
      .send({ username: "does-not-exist", password: "whatever123" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Invalid username or password");
  });

  test("logs in with correct credentials and returns a usable JWT", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    assert.equal(token.split(".").length, 3);
  });

  test("locks the account out after repeated failed attempts", async () => {
    await seedUser({ username: "lockout-target", password: "CorrectPass123!", role: "member" });
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/login")
        .send({ username: "lockout-target", password: "wrong" });
      assert.equal(res.status, 401);
    }
    const lockedRes = await request(app)
      .post("/api/login")
      .send({ username: "lockout-target", password: "wrong" });
    assert.equal(lockedRes.status, 429);

    // Even the *correct* password is refused while locked out.
    const correctButLocked = await request(app)
      .post("/api/login")
      .send({ username: "lockout-target", password: "CorrectPass123!" });
    assert.equal(correctButLocked.status, 429);
  });
});

describe("route protection", () => {
  test("rejects unauthenticated access to the cave database", async () => {
    const res = await request(app).get("/api/cave-database");
    assert.equal(res.status, 401);
  });

  test("allows authenticated access to the cave database", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  test("rejects a forged/garbage bearer token", async () => {
    const res = await request(app)
      .get("/api/cave-database")
      .set("Authorization", "Bearer not-a-real-token");
    assert.equal(res.status, 403);
  });

  test("rejects a member on a webmaster-only route", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 403);
  });

  test("allows a webmaster on a webmaster-only route", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
  });

  test("rejects a member from writing the cave database (admin/webmaster only)", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "createNew", cave: { county: "01", name: "Should Not Be Created" } });
    assert.equal(res.status, 403);
  });
});

// Webmaster accounts sit at the top of the permission ladder and never hold
// any other role - the Account Management UI doesn't offer a role/status/
// delete control for webmaster rows at all, and these routes enforce the
// same rule server-side so a direct API call can't do what the UI hides.
describe("webmaster accounts are protected from other webmasters", () => {
  before(async () => {
    await seedUser({ username: "protectedwebmaster", password: "ProtectedPass123!", role: "webmaster" });
  });

  test("a webmaster cannot change another webmaster's role", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/change-user-role")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "protectedwebmaster", newRole: "member" });
    assert.equal(res.status, 403);

    const usersRes = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`);
    const stillWebmaster = usersRes.body.find((u) => u.username === "protectedwebmaster");
    assert.equal(stillWebmaster.role, "webmaster");
  });

  test("a webmaster cannot disable another webmaster's account", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/toggle-user-status")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "protectedwebmaster", isActive: false });
    assert.equal(res.status, 403);
  });

  test("a webmaster cannot delete another webmaster's account", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .delete("/api/delete-user")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "protectedwebmaster" });
    assert.equal(res.status, 403);
  });

  test("a webmaster can still change a non-webmaster's role", async () => {
    await seedUser({ username: "promotable", password: "PromotablePass123!", role: "member" });
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/change-user-role")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "promotable", newRole: "admin" });
    assert.equal(res.status, 200);
  });
});

describe("password hashing", () => {
  test("stores a bcrypt hash, never the plaintext password, on self-registration", async () => {
    const res = await request(app).post("/api/create-account").send({ firstName: "Test", lastName: "Member",
      username: "newmember",
      email: "newmember@example.com",
      password: "SomeStrongPass123!",
    });
    assert.equal(res.status, 200);

    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const created = users.find((u) => u.username === "newmember");
    assert.ok(created, "new user should be present in users.json");
    assert.equal(created.password, undefined, "plaintext password must never be stored");
    assert.ok(created.passwordHash.startsWith("$2"), "should store a bcrypt hash");
    assert.equal(created.status, "pending", "self-registration should start pending, not active");
  });

  test("rejects a password shorter than the minimum length", async () => {
    const res = await request(app).post("/api/create-account").send({ firstName: "Test", lastName: "Member",
      username: "shortpw",
      email: "shortpw@example.com",
      password: "short1",
    });
    assert.equal(res.status, 400);
  });

  // Regression test for a stored-XSS chain: this route is unauthenticated,
  // and username/email are later rendered in the webmaster's Account
  // Management table - a username containing HTML/script syntax must never
  // be accepted in the first place (defense-in-depth alongside escaping it
  // on render).
  test("rejects a username containing HTML/script syntax", async () => {
    const res = await request(app).post("/api/create-account").send({ firstName: "Test", lastName: "Member",
      username: '<img src=x onerror=alert(1)>',
      email: "xssattempt@example.com",
      password: "SomeStrongPass123!",
    });
    assert.equal(res.status, 400);

    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    assert.ok(!users.some((u) => u.email === "xssattempt@example.com"), "no account should have been created");
  });

  test("rejects an email address containing HTML/script syntax", async () => {
    const res = await request(app).post("/api/create-account").send({ firstName: "Test", lastName: "Member",
      username: "emailxssattempt",
      email: '"><script>alert(1)</script>@example.com',
      password: "SomeStrongPass123!",
    });
    assert.equal(res.status, 400);
  });

  test("a freshly hashed password actually verifies on login", async () => {
    await request(app).post("/api/create-account").send({ firstName: "Test", lastName: "Member",
      username: "roundtrip",
      email: "roundtrip@example.com",
      password: "RoundTripPass123!",
    });
    // Activate the pending account directly (no client-facing endpoint
    // creates an already-active account other than webmaster-managed ones).
    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const user = users.find((u) => u.username === "roundtrip");
    user.status = "active";
    fs.writeFileSync(usersFilePath(), JSON.stringify(users, null, 2));

    const token = await login("roundtrip", "RoundTripPass123!");
    assert.ok(token);
  });
});

describe("admin notification emails", () => {
  // No SMTP is configured in the test env, so these log to the console
  // instead of actually emailing (see sendAdminNotification in server.js) -
  // same capture pattern as the password-reset tests above.
  async function captureNotificationLog(action) {
    const originalLog = console.log;
    let capturedLine = null;
    console.log = (...args) => {
      const line = args.join(" ");
      if (line.startsWith('[DEV] Admin notification "')) capturedLine = line;
      originalLog(...args);
    };
    try {
      await action();
    } finally {
      console.log = originalLog;
    }
    return capturedLine;
  }

  before(async () => {
    await seedUser({ username: "notifyadmin", password: "NotifyAdminPass123!", role: "admin" });
    await seedUser({
      username: "notifypendingwebmaster",
      password: "NotifyPendingWmPass123!",
      role: "webmaster",
      status: "pending",
    });
  });

  test("a new self-registration notifies active webmasters, not admins or inactive webmasters", async () => {
    const line = await captureNotificationLog(async () => {
      const res = await request(app).post("/api/create-account").send({ firstName: "Test", lastName: "Member",
        username: "notifytestaccount",
        email: "notifytestaccount@example.com",
        password: "SomeStrongPass123!",
      });
      assert.equal(res.status, 200);
    });

    assert.ok(line, "expected a [DEV] admin notification to be logged");
    assert.match(line, /New Account Awaiting Approval/);
    assert.match(line, /webmaster1@example\.com/);
    assert.doesNotMatch(line, /notifyadmin@example\.com/, "admin should not be notified of a new account");
    assert.doesNotMatch(
      line,
      /notifypendingwebmaster@example\.com/,
      "a pending (not yet active) webmaster should not be notified"
    );
  });

  test("a new pending submission notifies both active webmasters and admins", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);

    const line = await captureNotificationLog(async () => {
      const res = await request(app)
        .post("/api/pending-submissions")
        .set("Authorization", `Bearer ${memberToken}`)
        .send({
          type: "new_cave",
          caveId: "F01NOTIFYTEMP",
          county: "AL",
          proposedData: { name: "Notification Test Cave", county: "AL", type: "Land Cave", lat: 29.1, lng: -82.1 },
        });
      assert.equal(res.status, 200);
    });

    assert.ok(line, "expected a [DEV] admin notification to be logged");
    assert.match(line, /Submission Pending Review/);
    assert.match(line, /webmaster1@example\.com/);
    assert.match(line, /notifyadmin@example\.com/);
  });
});

describe("webmaster-created user accounts (POST /api/create-user)", () => {
  test("a webmaster can create an active member account directly", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/create-user")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Test", lastName: "Member", username: "webcreated1", email: "webcreated1@example.com", password: "WebCreatedPass123!" });
    assert.equal(res.status, 200);

    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const created = users.find((u) => u.username === "webcreated1");
    assert.ok(created, "new user should be present in users.json");
    assert.equal(created.role, "member");
    assert.equal(created.status, "active", "webmaster-created accounts should be active immediately, not pending");
    assert.equal(created.password, undefined, "plaintext password must never be stored");
    assert.ok(created.passwordHash.startsWith("$2"), "should store a bcrypt hash");

    // And it can actually log in right away, with no separate approval step.
    const loginToken = await login("webcreated1", "WebCreatedPass123!");
    assert.ok(loginToken);
  });

  test("requires a first and last name, and builds the full name from them", async () => {
    const wm = `Bearer ${await login("webmaster1", WEBMASTER_PASSWORD)}`;
    const missing = await request(app)
      .post("/api/create-user")
      .set("Authorization", wm)
      .send({ username: "nofullname", email: "nofullname@example.com", password: "NoFullNamePass123!" });
    assert.equal(missing.status, 400);

    await request(app)
      .post("/api/create-user")
      .set("Authorization", wm)
      .send({ firstName: "Dana", lastName: "Rivers", username: "nofullname", email: "nofullname@example.com", password: "NoFullNamePass123!" });
    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const created = users.find((u) => u.username === "nofullname");
    assert.equal(created.firstName, "Dana");
    assert.equal(created.lastName, "Rivers");
    assert.equal(created.fullName, "Dana Rivers");
  });

  test("a member cannot create a user account", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/create-user")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Test", lastName: "Member", username: "shouldnotexist", email: "shouldnotexist@example.com", password: "SomePass123!" });
    assert.equal(res.status, 403);
  });

  test("rejects an unauthenticated request", async () => {
    const res = await request(app)
      .post("/api/create-user")
      .send({ username: "noauth", email: "noauth@example.com", password: "SomePass123!" });
    assert.equal(res.status, 401);
  });

  test("rejects a duplicate username", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/create-user")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Test", lastName: "Member", username: "member1", email: "different@example.com", password: "SomePass123!" });
    assert.equal(res.status, 400);
  });

  test("rejects a password shorter than the minimum length", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/create-user")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Test", lastName: "Member", username: "shortpwweb", email: "shortpwweb@example.com", password: "short1" });
    assert.equal(res.status, 400);
  });

  // Same regression as public self-registration: this username/email is
  // rendered in the Account Management table too.
  test("rejects a username containing HTML/script syntax", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/create-user")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Test", lastName: "Member", username: '<img src=x onerror=alert(1)>', email: "webxss@example.com", password: "SomePass123!" });
    assert.equal(res.status, 400);

    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    assert.ok(!users.some((u) => u.email === "webxss@example.com"), "no account should have been created");
  });
});

describe("statistics card preferences (GET/POST /api/stats-preferences)", () => {
  test("defaults to empty hidden/order before anything is ever saved", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app).get("/api/stats-preferences").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { hidden: [], order: [] });
  });

  test("a member (not just admin/webmaster) can save and read back their own layout", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const saveRes = await request(app)
      .post("/api/stats-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ hidden: ["equipment", "geology"], order: ["nationwide", "summary"] });
    assert.equal(saveRes.status, 200);

    const getRes = await request(app).get("/api/stats-preferences").set("Authorization", `Bearer ${token}`);
    assert.equal(getRes.status, 200);
    assert.deepEqual(getRes.body, { hidden: ["equipment", "geology"], order: ["nationwide", "summary"] });
  });

  test("one account's saved layout doesn't affect another's", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    await request(app)
      .post("/api/stats-preferences")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ hidden: ["dimensions"], order: [] });

    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/stats-preferences").set("Authorization", `Bearer ${webmasterToken}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hidden.includes("dimensions"), "webmaster1's own layout should be unaffected by member1's save");
  });

  test("rejects an unrecognized card id", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/stats-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ hidden: ["not-a-real-card"], order: [] });
    assert.equal(res.status, 400);
  });

  test("rejects a non-array hidden/order", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/stats-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ hidden: "summary", order: [] });
    assert.equal(res.status, 400);
  });

  test("rejects an unauthenticated request on both routes", async () => {
    const getRes = await request(app).get("/api/stats-preferences");
    assert.equal(getRes.status, 401);
    const postRes = await request(app).post("/api/stats-preferences").send({ hidden: [], order: [] });
    assert.equal(postRes.status, 401);
  });
});

describe("change password", () => {
  before(async () => {
    await seedUser({ username: "changepassuser", password: "OldPassword123!", role: "member" });
  });

  test("changes the password given the correct current password, and the old password stops working", async () => {
    const token = await login("changepassuser", "OldPassword123!");
    const res = await request(app)
      .post("/api/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "OldPassword123!", newPassword: "BrandNewPassword123!" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const newLogin = await login("changepassuser", "BrandNewPassword123!");
    assert.ok(newLogin);

    const oldLoginRes = await request(app)
      .post("/api/login")
      .send({ username: "changepassuser", password: "OldPassword123!" });
    assert.equal(oldLoginRes.status, 401);
  });

  test("rejects an incorrect current password", async () => {
    const token = await login("changepassuser", "BrandNewPassword123!");
    const res = await request(app)
      .post("/api/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "TotallyWrongPassword!", newPassword: "AnotherNewPassword123!" });
    assert.equal(res.status, 401);

    // The password must not have changed.
    const stillWorks = await login("changepassuser", "BrandNewPassword123!");
    assert.ok(stillWorks);
  });

  test("requires authentication", async () => {
    const res = await request(app)
      .post("/api/change-password")
      .send({ currentPassword: "BrandNewPassword123!", newPassword: "AnotherNewPassword123!" });
    assert.equal(res.status, 401);
  });

  test("rejects a new password shorter than the minimum length", async () => {
    const token = await login("changepassuser", "BrandNewPassword123!");
    const res = await request(app)
      .post("/api/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "BrandNewPassword123!", newPassword: "short1" });
    assert.equal(res.status, 400);
  });
});

describe("change username (POST /api/change-username)", () => {
  before(async () => {
    await seedUser({ username: "changeunameuser", password: "ChangeUnamePass123!", role: "member" });
    await seedUser({ username: "unametaken", password: "UnameTakenPass123!", role: "member" });
  });

  test("a member (not just admin/webmaster) can change their own username given the correct password", async () => {
    const token = await login("changeunameuser", "ChangeUnamePass123!");
    const res = await request(app)
      .post("/api/change-username")
      .set("Authorization", `Bearer ${token}`)
      .send({ newUsername: "renameduser1", currentPassword: "ChangeUnamePass123!" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.username, "renameduser1");
    assert.ok(res.body.token, "should issue a fresh token carrying the new username");

    // The old username no longer exists; the new one works, same password.
    const oldLoginRes = await request(app)
      .post("/api/login")
      .send({ username: "changeunameuser", password: "ChangeUnamePass123!" });
    assert.equal(oldLoginRes.status, 401);
    const newLoginToken = await login("renameduser1", "ChangeUnamePass123!");
    assert.ok(newLoginToken);
  });

  test("the freshly issued token actually authenticates as the new username", async () => {
    const token = await login("renameduser1", "ChangeUnamePass123!");
    const res = await request(app)
      .post("/api/change-username")
      .set("Authorization", `Bearer ${token}`)
      .send({ newUsername: "renameduser2", currentPassword: "ChangeUnamePass123!" });
    assert.equal(res.status, 200);

    // Use the token the rename itself returned - not a fresh login - to
    // prove the new token is immediately valid for the renamed account,
    // the way the client is expected to swap it in without re-logging in.
    const changePassRes = await request(app)
      .post("/api/change-password")
      .set("Authorization", `Bearer ${res.body.token}`)
      .send({ currentPassword: "ChangeUnamePass123!", newPassword: "StillWorksPass123!" });
    assert.equal(changePassRes.status, 200);
  });

  test("rejects an incorrect current password", async () => {
    const token = await login("unametaken", "UnameTakenPass123!");
    const res = await request(app)
      .post("/api/change-username")
      .set("Authorization", `Bearer ${token}`)
      .send({ newUsername: "shouldnotapply", currentPassword: "TotallyWrongPassword!" });
    assert.equal(res.status, 401);

    const stillWorks = await login("unametaken", "UnameTakenPass123!");
    assert.ok(stillWorks);
  });

  test("rejects a username that's already taken", async () => {
    const token = await login("unametaken", "UnameTakenPass123!");
    const res = await request(app)
      .post("/api/change-username")
      .set("Authorization", `Bearer ${token}`)
      .send({ newUsername: "member1", currentPassword: "UnameTakenPass123!" });
    assert.equal(res.status, 400);
  });

  test("rejects a username containing HTML/script syntax", async () => {
    const token = await login("unametaken", "UnameTakenPass123!");
    const res = await request(app)
      .post("/api/change-username")
      .set("Authorization", `Bearer ${token}`)
      .send({ newUsername: '<img src=x onerror=alert(1)>', currentPassword: "UnameTakenPass123!" });
    assert.equal(res.status, 400);
  });

  test("requires authentication", async () => {
    const res = await request(app)
      .post("/api/change-username")
      .send({ newUsername: "shouldnotapply", currentPassword: "UnameTakenPass123!" });
    assert.equal(res.status, 401);
  });
});

describe("password reset", () => {
  // No SMTP is configured in the test env, so the server logs the reset
  // link to the console instead of emailing it (see sendPasswordResetEmail
  // in server.js) - capture that console.log call to get a real, valid
  // token to drive the rest of the flow with.
  async function requestResetToken(email) {
    const originalLog = console.log;
    let capturedUrl = null;
    console.log = (...args) => {
      const line = args.join(" ");
      const match = line.match(/\[DEV\] Password reset link for [^:]+: (\S+)/);
      if (match) capturedUrl = match[1];
      originalLog(...args);
    };
    try {
      const res = await request(app).post("/api/forgot-password").send({ email });
      assert.equal(res.status, 200);
    } finally {
      console.log = originalLog;
    }
    assert.ok(capturedUrl, "expected a [DEV] reset link to be logged");
    return new URL(capturedUrl).searchParams.get("resetToken");
  }

  before(async () => {
    await seedUser({ username: "resetuser", password: "OldPassword123!", role: "member" });
  });

  test("returns the same generic response whether or not the email exists (no account enumeration)", async () => {
    const known = await request(app).post("/api/forgot-password").send({ email: "resetuser@example.com" });
    const unknown = await request(app).post("/api/forgot-password").send({ email: "nobody@example.com" });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(known.body, unknown.body);
  });

  test("resets the password with a valid token, and the new password works on login", async () => {
    const token = await requestResetToken("resetuser@example.com");
    assert.ok(token);

    const resetRes = await request(app)
      .post("/api/reset-password")
      .send({ token, newPassword: "BrandNewPassword123!" });
    assert.equal(resetRes.status, 200);

    const newToken = await login("resetuser", "BrandNewPassword123!");
    assert.ok(newToken);

    // The old password must no longer work.
    const oldLoginRes = await request(app)
      .post("/api/login")
      .send({ username: "resetuser", password: "OldPassword123!" });
    assert.equal(oldLoginRes.status, 401);
  });

  test("rejects a reset token that has already been used once", async () => {
    const token = await requestResetToken("resetuser@example.com");
    const first = await request(app)
      .post("/api/reset-password")
      .send({ token, newPassword: "FirstUsePass123!" });
    assert.equal(first.status, 200);

    const second = await request(app)
      .post("/api/reset-password")
      .send({ token, newPassword: "SecondUsePass123!" });
    assert.equal(second.status, 400);
  });

  test("rejects a garbage/forged reset token", async () => {
    const res = await request(app)
      .post("/api/reset-password")
      .send({ token: "not-a-real-token", newPassword: "WhateverPass123!" });
    assert.equal(res.status, 400);
  });

  test("rejects a new password shorter than the minimum length", async () => {
    const token = await requestResetToken("resetuser@example.com");
    const res = await request(app).post("/api/reset-password").send({ token, newPassword: "short1" });
    assert.equal(res.status, 400);
  });
});

describe("cave database storage", () => {
  test("round-trips a cave name containing a double quote safely (regression for the old eval-based storage)", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const saveRes = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${token}`)
      .send({
        action: "createNew",
        cave: { county: "01", name: 'Cave "Quoted" Name', latitude: 29.1, longitude: -82.3 },
      });
    assert.equal(saveRes.status, 200);

    const getRes = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    const stored = getRes.body.find((c) => c.name === 'Cave "Quoted" Name');
    assert.ok(stored, "cave with an embedded quote should be stored and readable as plain data");
  });

  test("creates a backup file before overwriting the cave database", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const backupDir = path.join(process.env.DATA_DIR, "backups");
    const before = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0;

    await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "createNew", cave: { county: "02", name: "Backup Trigger Cave" } });

    const afterCount = fs.readdirSync(backupDir).length;
    assert.ok(afterCount > before, "expected a new backup file after the write");
  });

  test("defaults a new cave to Florida when no state is given (backward compatibility)", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "createNew", cave: { county: "AL", name: "No State Given Cave" } });
    assert.equal(res.status, 200);
    assert.match(res.body.caveId, /^FAL\d{3}$/);
  });

  test("generates a state-prefixed ID for a non-Florida state, numbered independently of Florida's same county code", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);

    // Seed a Florida cave in county "AL" first...
    const flRes = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "createNew", cave: { state: "FL", county: "AL", name: "Florida Alachua Cave" } });
    assert.equal(flRes.status, 200);

    // ...then a Georgia cave that happens to reuse "AL" as its own county
    // code (Georgia's real code for Allen County) - must not collide with
    // or continue Florida's numbering for that same county-code string.
    const gaRes = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "createNew", cave: { state: "GA", county: "AL", name: "Georgia Allen Cave" } });
    assert.equal(gaRes.status, 200);
    assert.match(gaRes.body.caveId, /^GAAL\d{3}$/);
    assert.notEqual(gaRes.body.caveId, flRes.body.caveId);

    const dbRes = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    const gaCave = dbRes.body.find((c) => c.id === gaRes.body.caveId);
    assert.equal(gaCave.state, "GA");
    assert.equal(gaCave.county, "AL");
  });
});

// Uses Wyoming throughout (untouched by any other test in this file) so the
// per-state count for it can be asserted exactly.
describe("nationwide cave counts", () => {
  before(async () => {
    await seedUser({ username: "wyscopedmember", password: "WyScopedPass123!", role: "member", allowedStates: ["WY"] });

    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    for (const name of ["Wyoming Cave One", "Wyoming Cave Two"]) {
      const res = await request(app)
        .post("/api/save-cave-database")
        .set("Authorization", `Bearer ${token}`)
        .send({ action: "createNew", cave: { state: "WY", county: "AL", name } });
      assert.equal(res.status, 200);
    }
  });

  test("requires authentication", async () => {
    const res = await request(app).get("/api/cave-database/state-counts");
    assert.equal(res.status, 401);
  });

  test("reports Wyoming's count and includes it in the nationwide total", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/cave-database/state-counts").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.total, "number");
    assert.ok(Array.isArray(res.body.states));
    assert.equal(res.body.states.length, 50);

    const wyoming = res.body.states.find((s) => s.code === "WY");
    assert.ok(wyoming, "Wyoming must be present even with a nonzero count");
    assert.equal(wyoming.name, "Wyoming");
    assert.equal(wyoming.count, 2);

    const sumOfStates = res.body.states.reduce((sum, s) => sum + s.count, 0);
    assert.equal(sumOfStates, res.body.total, "per-state counts must add up to the nationwide total");
  });

  test("is NOT scoped by allowedStates - a Wyoming-only member still sees every state's count and the same nationwide total", async () => {
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const webmasterRes = await request(app)
      .get("/api/cave-database/state-counts")
      .set("Authorization", `Bearer ${webmasterToken}`);

    const memberToken = await login("wyscopedmember", "WyScopedPass123!");
    const memberRes = await request(app)
      .get("/api/cave-database/state-counts")
      .set("Authorization", `Bearer ${memberToken}`);

    assert.equal(memberRes.status, 200);
    assert.equal(memberRes.body.total, webmasterRes.body.total);
    assert.equal(memberRes.body.states.length, webmasterRes.body.states.length);

    // Confirm the scoped member can see a state they are NOT granted (e.g.
    // Florida, seeded elsewhere in this file) in this breakdown - unlike
    // GET /api/cave-database, which would hide it entirely.
    const floridaViaMember = memberRes.body.states.find((s) => s.code === "FL");
    assert.ok(floridaViaMember, "a Wyoming-only member must still see Florida's count here");
  });
});

describe("public Florida cave count (header banner)", () => {
  test("GET /api/cave-count is public - no login token needed, for the logged-out login screen", async () => {
    const res = await request(app).get("/api/cave-count");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.count, "number");
  });

  test("counts distinct Florida caves only - adding one Florida cave increases it by exactly one, regardless of its entrance count", async () => {
    const before = await request(app).get("/api/cave-count");

    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const createRes = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${token}`)
      .send({
        action: "createNew",
        cave: {
          state: "FL",
          county: "AL",
          name: "Cave Count Banner Test Cave",
          entrances: [{ name: "Second Entrance" }, { name: "Third Entrance" }],
        },
      });
    assert.equal(createRes.status, 200);

    const after = await request(app).get("/api/cave-count");
    assert.equal(after.body.count, before.body.count + 1, "extra entrances on the same cave must not inflate the count");
  });

  test("does not count other states - adding a Wyoming cave leaves the Florida count unchanged", async () => {
    const before = await request(app).get("/api/cave-count");

    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const createRes = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "createNew", cave: { state: "WY", county: "AL", name: "Cave Count Banner Wyoming Cave" } });
    assert.equal(createRes.status, 200);

    const after = await request(app).get("/api/cave-count");
    assert.equal(after.body.count, before.body.count, "a non-Florida cave must not change the Florida count");
  });

  test("collapses legacy lettered-suffix sibling records (FJK0227a/FJK0227b) into one cave", () => {
    const caves = [
      { id: "FJK0227a", name: "Jackson Blue Spring" },
      { id: "FJK0227b", name: "Source Nuveau" },
      { id: "FAL0001", name: "Alligator Hole" },
    ];
    assert.equal(app.countDistinctCaves(caves), 2, "the lettered pair must count as one cave, plus the unrelated one");
  });

  test("countTotalEntrances counts every entrance, nested or lettered-suffix, unlike countDistinctCaves", () => {
    const caves = [
      { id: "FJK0227a", name: "Jackson Blue Spring" },
      { id: "FJK0227b", name: "Source Nuveau" },
      { id: "FAL0001", name: "Alligator Hole", entrances: [{ name: "Second Entrance" }, { name: "Third Entrance" }] },
    ];
    assert.equal(app.countDistinctCaves(caves), 2);
    assert.equal(app.countTotalEntrances(caves), 2 + 3, "the lettered pair is 2 entrances, the nested-entrance cave is 1 + 2");
  });

  test("caveBaseId only strips a trailing lowercase letter after a digit, not a normal ID", () => {
    assert.equal(app.caveBaseId("FJK0227a"), "FJK0227");
    assert.equal(app.caveBaseId("FJK0227"), "FJK0227");
    assert.equal(app.caveBaseId(""), "");
    assert.equal(app.caveBaseId(null), null);
  });

  test("resolveCaveStateAndCounty resolves a lettered-suffix sibling (no explicit state/county) the same as its unsuffixed peer", () => {
    const plain = app.resolveCaveStateAndCounty({ id: "FJK0227" });
    const suffixed = app.resolveCaveStateAndCounty({ id: "FJK0227a" });
    assert.deepEqual(plain, { state: "FL", county: "JK" });
    assert.deepEqual(
      suffixed,
      plain,
      "a lettered-suffix sibling record predates the explicit state/county fields just like its unsuffixed peer, " +
        "and must resolve the same way - otherwise it silently drops out of every state-scoped cave count"
    );
  });
});

describe("state/county reference config", () => {
  test("GET /api/states is public (no login token) - the create-account form needs it before anyone is logged in", async () => {
    const res = await request(app).get("/api/states");
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 50);
  });

  test("GET /api/states returns all 50 states with Florida's counties intact", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/states").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 50);

    const florida = res.body.find((s) => s.code === "FL");
    assert.ok(florida, "Florida must be present");
    assert.equal(florida.caveIdPrefix, "F");
    assert.equal(florida.counties.length, 67);
    assert.ok(florida.counties.some((c) => c.code === "AL" && c.name === "Alachua"));

    // Every state has a unique 2-letter county code within itself, and a
    // non-empty county list - a regenerated config that broke either of
    // these would silently corrupt cave ID generation.
    for (const state of res.body) {
      assert.ok(state.counties.length > 0, `${state.code} has no counties`);
      const codes = state.counties.map((c) => c.code);
      assert.equal(new Set(codes).size, codes.length, `${state.code} has duplicate county codes`);
    }
  });

  test("a member (not just webmaster) can read the reference data", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app).get("/api/states").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 50);
  });
});

// Uses Texas throughout (never touched by any other test in this file) so
// these tests can assert on exact generated cave IDs without needing to
// know what other tests already did to Florida/Georgia's county numbering.
// The bulk Excel-import admin tool (and its now-removed
// GET /api/cave-database/import-template / POST /api/cave-database/import
// routes) was removed along with the rest of the multi-state machinery -
// this site only ever hosts Florida data, so a tool for onboarding a new
// state's spreadsheet no longer has a purpose.
describe("cave database Excel import has been removed", () => {
  test("GET /api/cave-database/import-template no longer exists", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .get("/api/cave-database/import-template?state=FL")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 404);
  });

  test("POST /api/cave-database/import no longer exists", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/cave-database/import")
      .set("Authorization", `Bearer ${token}`)
      .field("state", "FL");
    assert.equal(res.status, 404);
  });
});

// This site only ever hosts Florida data, so there is nothing left to
// restrict any account to - every user, regardless of role or whatever
// may be stored in their own allowedStates field, is unrestricted (see
// getAllowedStatesForUser in server.js). There is no longer a route to
// set a per-user restriction (POST /api/change-user-states was removed
// along with the Account Management/account-creation UI that drove it).
describe("every account is unrestricted (this site only hosts Florida)", () => {
  before(async () => {
    // Even a user record that still has a leftover allowedStates array
    // (e.g. from data predating this change) must come back unrestricted.
    await seedUser({ username: "leftoverscopeduser", password: "ScopedPass123!", role: "member", allowedStates: ["FL"] });
  });

  test("GET /api/users reports null (unrestricted) for every account", async () => {
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/users").set("Authorization", `Bearer ${webmasterToken}`);
    assert.equal(res.status, 200);

    const wm = res.body.find((u) => u.username === "webmaster1");
    assert.equal(wm.allowedStates, null);

    const leftover = res.body.find((u) => u.username === "leftoverscopeduser");
    assert.equal(leftover.allowedStates, null);
  });

  test("POST /api/change-user-states no longer exists", async () => {
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/change-user-states")
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ username: "leftoverscopeduser", allowedStates: ["FL", "GA"] });
    assert.equal(res.status, 404);
  });

  test("a member with a leftover allowedStates array can still see every cave", async () => {
    const memberToken = await login("leftoverscopeduser", "ScopedPass123!");
    const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${memberToken}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });
});

describe("two-factor authentication", () => {
  // No SMTP is configured in the test env, so the server logs the code to
  // the console instead of emailing it (see sendTwoFactorCode in server.js).
  async function captureDevLog(pattern, action) {
    const originalLog = console.log;
    let captured = null;
    console.log = (...args) => {
      const line = args.join(" ");
      const match = line.match(pattern);
      if (match) captured = match[1];
      originalLog(...args);
    };
    let result;
    try {
      result = await action();
    } finally {
      console.log = originalLog;
    }
    return { result, captured };
  }

  const CODE_PATTERN = /\[DEV\] Two-factor code for [^:]+: (\d{6})/;

  async function loginCapturingCode(username, password) {
    const { result, captured } = await captureDevLog(CODE_PATTERN, () =>
      request(app).post("/api/login").send({ username, password })
    );
    return { res: result, code: captured };
  }

  before(async () => {
    await seedUser({ username: "twofauser", password: "TwoFaPass123!", role: "member" });
    const loginToken = await login("twofauser", "TwoFaPass123!");
    const enableRes = await request(app)
      .post("/api/toggle-2fa")
      .set("Authorization", `Bearer ${loginToken}`)
      .send({ enabled: true });
    assert.equal(enableRes.status, 200);
    assert.equal(enableRes.body.twoFactorEnabled, true);
  });

  test("a login attempt on a 2FA-enabled account returns a pending token instead of a session, and emails a code", async () => {
    const { res, code } = await loginCapturingCode("twofauser", "TwoFaPass123!");
    assert.equal(res.status, 200);
    assert.equal(res.body.twoFactorRequired, true);
    assert.ok(res.body.twoFactorToken);
    assert.equal(res.body.success, undefined);
    assert.equal(res.body.token, undefined);
    assert.ok(code, "expected a [DEV] two-factor code to be logged");
  });

  test("a pending 2FA token cannot be used as a session token on a normal protected route", async () => {
    const { res } = await loginCapturingCode("twofauser", "TwoFaPass123!");
    const dbRes = await request(app)
      .get("/api/cave-database")
      .set("Authorization", `Bearer ${res.body.twoFactorToken}`);
    assert.equal(dbRes.status, 401);
  });

  test("verify-2fa rejects an incorrect code", async () => {
    const { res } = await loginCapturingCode("twofauser", "TwoFaPass123!");
    const verifyRes = await request(app)
      .post("/api/verify-2fa")
      .send({ twoFactorToken: res.body.twoFactorToken, code: "000000" });
    assert.equal(verifyRes.status, 401);
  });

  test("verify-2fa issues a real, working session token for the correct code", async () => {
    const { res, code } = await loginCapturingCode("twofauser", "TwoFaPass123!");
    const verifyRes = await request(app)
      .post("/api/verify-2fa")
      .send({ twoFactorToken: res.body.twoFactorToken, code });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.body.success, true);
    assert.ok(verifyRes.body.token);

    const dbRes = await request(app)
      .get("/api/cave-database")
      .set("Authorization", `Bearer ${verifyRes.body.token}`);
    assert.equal(dbRes.status, 200);
  });

  test("verify-2fa locks out after too many incorrect attempts", async () => {
    const { res } = await loginCapturingCode("twofauser", "TwoFaPass123!");
    const pendingToken = res.body.twoFactorToken;

    let lastRes;
    for (let i = 0; i < 6; i++) {
      lastRes = await request(app)
        .post("/api/verify-2fa")
        .send({ twoFactorToken: pendingToken, code: "111111" });
    }
    assert.equal(lastRes.status, 429);
  });

  test("resend-2fa issues a new code that also works to complete login", async () => {
    const { res } = await loginCapturingCode("twofauser", "TwoFaPass123!");
    const pendingToken = res.body.twoFactorToken;

    const { result: resendRes, captured: newCode } = await captureDevLog(CODE_PATTERN, () =>
      request(app).post("/api/resend-2fa").send({ twoFactorToken: pendingToken })
    );
    assert.equal(resendRes.status, 200);
    assert.ok(newCode);

    const verifyRes = await request(app)
      .post("/api/verify-2fa")
      .send({ twoFactorToken: pendingToken, code: newCode });
    assert.equal(verifyRes.status, 200);
  });

  test("disabling 2FA requires the correct current password", async () => {
    const { res, code } = await loginCapturingCode("twofauser", "TwoFaPass123!");
    const verifyRes = await request(app)
      .post("/api/verify-2fa")
      .send({ twoFactorToken: res.body.twoFactorToken, code });
    const sessionToken = verifyRes.body.token;

    const wrongPasswordRes = await request(app)
      .post("/api/toggle-2fa")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ enabled: false, password: "WrongPassword123!" });
    assert.equal(wrongPasswordRes.status, 401);

    const rightPasswordRes = await request(app)
      .post("/api/toggle-2fa")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ enabled: false, password: "TwoFaPass123!" });
    assert.equal(rightPasswordRes.status, 200);
    assert.equal(rightPasswordRes.body.twoFactorEnabled, false);

    // 2FA is off again, so login should succeed directly, no code needed.
    const directRes = await request(app)
      .post("/api/login")
      .send({ username: "twofauser", password: "TwoFaPass123!" });
    assert.equal(directRes.status, 200);
    assert.equal(directRes.body.success, true);
    assert.ok(directRes.body.token);
  });
});

describe("pending submissions", () => {
  test("a member's submission records the authenticated username, ignoring a spoofed submittedBy", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "F01TEMP",
        county: "AL",
        submittedBy: "someone-else",
        proposedData: { name: "Submission Test Cave", county: "AL", type: "Land Cave", lat: 29.1, lng: -82.1 },
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.submission.submittedBy, "member1");
    assert.equal(res.body.submission.status, "pending");
  });

  test("a member cannot approve or reject a submission", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const submitRes = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "F01TEMP2",
        county: "AL",
        proposedData: { name: "Member Cannot Approve Cave", county: "AL", type: "Land Cave", lat: 29.2, lng: -82.2 },
      });
    const submissionId = submitRes.body.submission.submissionId;

    const patchRes = await request(app)
      .patch(`/api/pending-submissions/${submissionId}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ status: "approved" });
    assert.equal(patchRes.status, 403);
  });

  test("approving a new_cave submission assigns a real cave ID and writes it into the cave database", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);

    const submitRes = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "F03TEMP",
        county: "BF",
        proposedData: { name: "Approved New Cave", county: "BF", type: "Land Cave", lat: 29.3, lng: -82.3 },
      });
    const submissionId = submitRes.body.submission.submissionId;

    const approveRes = await request(app)
      .patch(`/api/pending-submissions/${submissionId}`)
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ status: "approved", approvedBy: "spoofed-approver" });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.submission.approvedBy, "webmaster1"); // never the spoofed body value
    const assignedId = approveRes.body.submission.assignedCaveId;
    assert.ok(assignedId && assignedId.startsWith("FBF"), `expected an assigned FBF cave id, got ${assignedId}`);

    const dbRes = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${webmasterToken}`);
    const stored = dbRes.body.find((c) => c.id === assignedId);
    assert.ok(stored, "approved new cave should be written into the cave database");
    assert.equal(stored.name, "Approved New Cave");
  });

  test("approving a new_cave submission for a non-Florida state assigns that state's ID prefix", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);

    const submitRes = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "GATEMP",
        state: "GA",
        county: "BA",
        proposedData: { name: "Georgia Bacon County Cave", state: "GA", county: "BA", type: "Land Cave", lat: 31.7, lng: -82.4 },
      });
    const submissionId = submitRes.body.submission.submissionId;
    assert.equal(submitRes.body.submission.state, "GA");

    const approveRes = await request(app)
      .patch(`/api/pending-submissions/${submissionId}`)
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ status: "approved" });
    assert.equal(approveRes.status, 200);
    const assignedId = approveRes.body.submission.assignedCaveId;
    assert.match(assignedId, /^GABA\d{3}$/);

    const dbRes = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${webmasterToken}`);
    const stored = dbRes.body.find((c) => c.id === assignedId);
    assert.equal(stored.state, "GA");
    assert.equal(stored.county, "BA");
  });

  test("approving an edit_cave submission merges proposedData into the existing cave", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);

    const createRes = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ action: "createNew", cave: { county: "04", name: "Original Name", notes: "original notes" } });
    const caveId = createRes.body.caveId;

    const submitRes = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "edit_cave",
        caveId,
        proposedData: { name: "Edited Name", notes: "edited notes" },
      });
    const submissionId = submitRes.body.submission.submissionId;

    const approveRes = await request(app)
      .patch(`/api/pending-submissions/${submissionId}`)
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ status: "approved" });
    assert.equal(approveRes.status, 200);

    const dbRes = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${webmasterToken}`);
    const stored = dbRes.body.find((c) => c.id === caveId);
    assert.equal(stored.name, "Edited Name");
    assert.equal(stored.notes, "edited notes");
    assert.equal(stored.id, caveId); // id itself is never overwritten by proposedData
  });

  test("rejecting a submission records the reason and leaves the cave database untouched", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);

    const beforeDb = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${webmasterToken}`);
    const beforeCount = beforeDb.body.length;

    const submitRes = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "F05TEMP",
        county: "BK",
        proposedData: { name: "Rejected Cave", county: "BK", type: "Land Cave", lat: 29.5, lng: -82.5 },
      });
    const submissionId = submitRes.body.submission.submissionId;

    const rejectRes = await request(app)
      .patch(`/api/pending-submissions/${submissionId}`)
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ status: "rejected", rejectionReason: "Needs more detail", rejectedBy: "spoofed-rejector" });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.submission.rejectedBy, "webmaster1");
    assert.equal(rejectRes.body.submission.rejectionReason, "Needs more detail");

    const afterDb = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${webmasterToken}`);
    assert.equal(afterDb.body.length, beforeCount);
  });

  test("a submission cannot be approved twice", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);

    const submitRes = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "F06TEMP",
        county: "BR",
        proposedData: { name: "Double Approve Cave", county: "BR", type: "Land Cave", lat: 29.6, lng: -82.6 },
      });
    const submissionId = submitRes.body.submission.submissionId;

    const firstApprove = await request(app)
      .patch(`/api/pending-submissions/${submissionId}`)
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ status: "approved" });
    assert.equal(firstApprove.status, 200);

    const secondApprove = await request(app)
      .patch(`/api/pending-submissions/${submissionId}`)
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ status: "approved" });
    assert.equal(secondApprove.status, 409);
  });

  // Regression test for a stored-XSS chain: a new_cave submission's county
  // used to be stored verbatim with no validation, and once approved it
  // gets baked unescaped into the new cave's ID (see generateNextCaveId)
  // - which is rendered unescaped in the interactive map's popup, including
  // inside onclick="...('...')" attributes. A member submitting a crafted
  // county could execute JS in whatever webmaster/admin next opened the
  // map. Must be rejected at submission time, not just escaped on render.
  test("rejects a new_cave submission whose county isn't a real code for the state", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "FXSSTEMP",
        county: "X'-alert(document.cookie)-'",
        proposedData: { name: "XSS Attempt Cave", county: "X'-alert(document.cookie)-'", type: "Land Cave", lat: 29.1, lng: -82.1 },
      });
    assert.equal(res.status, 400);
  });

  test("rejects a new_cave submission with a plausible-looking but unrecognized county code", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "FZZTEMP",
        county: "ZZ",
        proposedData: { name: "Bad County Code Cave", county: "ZZ", type: "Land Cave", lat: 29.1, lng: -82.1 },
      });
    assert.equal(res.status, 400);
  });

  test("rejects a new_cave submission with no county at all", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "FNOCOUNTYTEMP",
        proposedData: { name: "No County Cave", type: "Land Cave", lat: 29.1, lng: -82.1 },
      });
    assert.equal(res.status, 400);
  });
});

describe("cave-data routes are unrestricted (no per-user state scoping)", () => {
  let gaCaveId;

  before(async () => {
    await seedUser({ username: "flonlymember", password: "FlOnlyPass123!", role: "member", allowedStates: ["FL"] });

    // Seed one Florida cave and one "other state" cave - even though this
    // site only ever hosts Florida data in practice, nothing should choke
    // on a stray non-FL record, and a member must be able to see it.
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ action: "createNew", cave: { state: "FL", county: "SC", name: "Scoping Test FL Cave" } });
    const gaRes = await request(app)
      .post("/api/save-cave-database")
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ action: "createNew", cave: { state: "GA", county: "SC", name: "Scoping Test GA Cave" } });
    gaCaveId = gaRes.body.caveId;
  });

  test("GET /api/cave-database returns every cave to every account, regardless of their own allowedStates", async () => {
    const token = await login("flonlymember", "FlOnlyPass123!");
    const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((c) => c.name === "Scoping Test FL Cave"));
    assert.ok(res.body.some((c) => c.name === "Scoping Test GA Cave"));
  });

  test("a member can submit a proposal for any state, not just their own stored allowedStates", async () => {
    const token = await login("flonlymember", "FlOnlyPass123!");
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "new_cave",
        caveId: "GATEMP2",
        state: "GA",
        county: "SC",
        proposedData: { name: "No Longer Rejected Cave", state: "GA", county: "SC" },
      });
    assert.equal(res.status, 200);
  });

  // edit_cave submission state is still resolved from the real cave server-
  // side, never trusted from the client - unrelated to allowedStates (there
  // is no longer any restriction to bypass), this just confirms the stored
  // submission accurately records which cave it's actually for.
  test("edit_cave submission state is resolved from the real cave, ignoring a mismatched client-supplied state", async () => {
    const token = await login("flonlymember", "FlOnlyPass123!");
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "edit_cave",
        caveId: gaCaveId,
        state: "FL", // mismatched on purpose - must be ignored in favor of the cave's real state
        county: "SC",
        proposedData: { name: "Legitimate GA Edit" },
      });
    assert.equal(res.status, 200);

    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const listRes = await request(app).get("/api/pending-submissions").set("Authorization", `Bearer ${webmasterToken}`);
    const stored = listRes.body.find((s) => s.caveId === gaCaveId && s.caveName === "Legitimate GA Edit");
    assert.ok(stored, "submission should exist");
    assert.equal(stored.state, "GA", "stored state must be the cave's real state, not the client-supplied FL");
  });
});

describe("X-Forwarded-Proto parsing (HTTPS-redirect middleware)", () => {
  // Regression test for a real production bug: this deployment's proxy
  // chain (nginx -> Apache) sends X-Forwarded-Proto as "https, https" (each
  // hop appends rather than replaces), not plain "https" - an exact-match
  // comparison against the header redirected every single request to
  // itself forever, even though the request genuinely was HTTPS
  // end-to-end. See the comment above isRequestOverHttps in server.js.
  const isRequestOverHttps = app.locals.isRequestOverHttps;

  test("treats a duplicated proxy chain value as HTTPS", () => {
    assert.equal(isRequestOverHttps("https, https"), true);
  });
  test("treats a plain value as HTTPS", () => {
    assert.equal(isRequestOverHttps("https"), true);
  });
  test("treats a value with mixed case/whitespace as HTTPS", () => {
    assert.equal(isRequestOverHttps(" HTTPS , http"), true);
  });
  test("treats plain http as not HTTPS", () => {
    assert.equal(isRequestOverHttps("http"), false);
  });
  test("treats a chain starting with http as not HTTPS", () => {
    assert.equal(isRequestOverHttps("http, https"), false);
  });
  test("returns null (no opinion) when the header is absent", () => {
    assert.equal(isRequestOverHttps(undefined), null);
  });
});

describe("path traversal protection", () => {
  test("does not escape the narrative-image directory via a traversal filename", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .get("/download-narrative-image/..%2f..%2f..%2fetc%2fpasswd")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 404); // sanitized to a nonexistent filename, never a leak
  });
});

describe("narrative content", () => {
  test("strips <script> and event-handler attributes from saved narrative HTML", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const saveRes = await request(app)
      .post("/save-narrative")
      .set("Authorization", `Bearer ${token}`)
      .send({
        id: "F01001",
        name: "Test Cave",
        html: '<p>Trip report</p><script>alert(1)</script><img src="x" onerror="alert(2)">',
        images: [],
      });
    assert.equal(saveRes.status, 200);

    const getRes = await request(app)
      .get("/get-narrative?id=F01001")
      .set("Authorization", `Bearer ${token}`);
    const saved = getRes.body[0];
    assert.ok(!saved.html.includes("<script"), "script tag must be stripped");
    assert.ok(!saved.html.includes("onerror"), "event-handler attribute must be stripped");
  });

  test("attributes a narrative to the authenticated user, ignoring a client-supplied one", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    await request(app)
      .post("/save-narrative")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "F01002", name: "Test Cave 2", html: "<p>hi</p>", user: "someone-else", images: [] });

    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const getRes = await request(app)
      .get("/get-narrative?id=F01002")
      .set("Authorization", `Bearer ${webmasterToken}`);
    assert.equal(getRes.body[0].user, "member1");
  });

  test("rejects an unsafe cave id instead of writing outside the narratives directory", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/save-narrative")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "../../etc/evil", name: "x", html: "<p>hi</p>", images: [] });
    assert.equal(res.status, 400);
  });
});

// Regression tests for a file-upload vulnerability: the route used to trust
// the client-supplied Content-Type of the uploaded part and the extension
// of the client-supplied filename, so a script-capable file (e.g. an SVG
// document containing an inline <script>) could be uploaded as a fake
// "image/png" and stored/served with its real, executable .svg extension.
// The fix sniffs the actual file bytes and derives the stored extension
// from that, never from anything the client claims.
describe("narrative image upload validates real file content", () => {
  test("rejects an SVG (script-capable) file even when declared as image/png", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const svgBuffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await request(app)
      .post("/upload-narrative-image")
      .set("Authorization", `Bearer ${token}`)
      .attach("image", svgBuffer, { filename: "poison.svg", contentType: "image/png" });
    assert.equal(res.status, 400);
  });

  test("rejects plain text declared as an image", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/upload-narrative-image")
      .set("Authorization", `Bearer ${token}`)
      .attach("image", Buffer.from("just some text, not an image"), {
        filename: "notreally.jpg",
        contentType: "image/jpeg",
      });
    assert.equal(res.status, 400);
  });

  test("accepts a real PNG and stores it with a .png extension regardless of the claimed filename", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    // Minimal valid 1x1 PNG (magic bytes + IHDR/IDAT/IEND chunks).
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    const res = await request(app)
      .post("/upload-narrative-image")
      .set("Authorization", `Bearer ${token}`)
      // Deliberately mismatched extension/claimed type - the response must
      // still reflect the DETECTED type (.png), not this claim.
      .attach("image", pngBuffer, { filename: "whatever.svg", contentType: "image/svg+xml" });
    assert.equal(res.status, 200);
    assert.match(res.body.imageUrl, /^\/cave-pictures\/\d+-\d+\.png$/);
  });
});

describe("disable large files mode", () => {
  after(async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ disableLargeFiles: false, disableLargeFilesMessage: "" });
  });

  test("blocks uploading a narrative photo, even for a webmaster", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ disableLargeFiles: true, disableLargeFilesMessage: "Large files are off for testing." });

    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    const res = await request(app)
      .post("/upload-narrative-image")
      .set("Authorization", `Bearer ${token}`)
      .attach("image", pngBuffer, { filename: "whatever.png", contentType: "image/png" });
    assert.equal(res.status, 403);
    assert.equal(res.body.largeFilesDisabled, true);
    assert.equal(res.body.error, "Large files are off for testing.");

    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ disableLargeFiles: false, disableLargeFilesMessage: "" });
  });

  test("blocks uploading a cave map file", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ disableLargeFiles: true });

    const res = await request(app)
      .post("/api/cave-maps/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("mapFiles", Buffer.from("not a real geotiff"), { filename: "test.tif", contentType: "image/tiff" });
    assert.equal(res.status, 403);
    assert.equal(res.body.largeFilesDisabled, true);

    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ disableLargeFiles: false });
  });

  test("blocks viewing/downloading an already-uploaded narrative photo", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    const uploadRes = await request(app)
      .post("/upload-narrative-image")
      .set("Authorization", `Bearer ${token}`)
      .attach("image", pngBuffer, { filename: "whatever.png", contentType: "image/png" });
    assert.equal(uploadRes.status, 200);
    const imageUrl = uploadRes.body.imageUrl;

    // Sanity check: viewable normally before the toggle.
    const beforeRes = await request(app).get(imageUrl).set("Authorization", `Bearer ${token}`);
    assert.equal(beforeRes.status, 200);

    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ disableLargeFiles: true });

    const afterRes = await request(app).get(imageUrl).set("Authorization", `Bearer ${token}`);
    assert.equal(afterRes.status, 403);
    assert.equal(afterRes.body.largeFilesDisabled, true);

    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ disableLargeFiles: false });
  });

  test("does not block submitting a new cave proposal or saving a narrative", async () => {
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ disableLargeFiles: true });

    const memberToken = await login("member1", MEMBER_PASSWORD);
    const submissionRes = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ type: "new_cave", caveId: "FLGTEMP", state: "FL", county: "AL", proposedData: { name: "Large Files Off Test Cave" } });
    assert.equal(submissionRes.status, 200);

    const narrativeRes = await request(app)
      .post("/save-narrative")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ id: "FAL001", html: "<p>Written while large files are disabled.</p>" });
    assert.equal(narrativeRes.status, 200);

    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ disableLargeFiles: false });
  });
});

// Deliberately last in the file: maintenance mode is a single global
// toggle (not partitionable the way a dedicated test state/user is for
// other describe blocks), so a test here that left it "on" would break
// every other describe block's member/unauthenticated-role assertions.
// The after() hook unconditionally restores the default (off) config,
// whatever happened in the tests above it.
describe("website management: site status, banner, and maintenance mode", () => {
  after(async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ maintenanceMode: false, maintenanceMessage: "", bannerEnabled: false, bannerMessage: "", bannerColor: "yellow" });
  });

  test("GET /api/site-status is public and defaults to everything off", async () => {
    const res = await request(app).get("/api/site-status");
    assert.equal(res.status, 200);
    assert.equal(res.body.maintenanceMode, false);
    assert.equal(res.body.bannerEnabled, false);
  });

  test("POST /api/site-config requires webmaster", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ bannerEnabled: true });
    assert.equal(res.status, 403);
  });

  test("banner message: a plain URL becomes a real link, a script tag does not survive", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({
        bannerEnabled: true,
        bannerColor: "red",
        bannerMessage: 'Scheduled downtime Friday. Details: https://example.com/notice <script>alert(1)</script>',
      });
    assert.equal(res.status, 200);
    assert.match(res.body.bannerHtml, /<a href="https:\/\/example\.com\/notice" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/notice<\/a>/);
    assert.ok(!res.body.bannerHtml.includes("<script"), "a typed <script> tag must never survive into bannerHtml");
    assert.ok(!res.body.bannerHtml.includes("alert(1)"), "script tag contents must not survive either");

    const statusRes = await request(app).get("/api/site-status");
    assert.equal(statusRes.body.bannerEnabled, true);
    assert.equal(statusRes.body.bannerColor, "red");
    assert.equal(statusRes.body.bannerHtml, res.body.bannerHtml);
  });

  test("banner message: email addresses and links without http:// are clickable too", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({
        bannerEnabled: true,
        bannerMessage:
          "Questions? Email webmaster@caves.org or see www.caves.org, fcs.caves.org/portal and https://example.com/a?x=1&y=2. " +
          "Info (https://en.wikipedia.org/wiki/Cave_(disambiguation)). Version 1.5 and Node.js aren't links.",
      });
    assert.equal(res.status, 200);
    const html = res.body.bannerHtml;
    assert.match(html, /<a href="mailto:webmaster@caves\.org">webmaster@caves\.org<\/a> or/);
    assert.match(html, /<a href="https:\/\/www\.caves\.org" target="_blank" rel="noopener noreferrer">www\.caves\.org<\/a>,/);
    assert.match(html, /<a href="https:\/\/fcs\.caves\.org\/portal" target="_blank" rel="noopener noreferrer">fcs\.caves\.org\/portal<\/a> and/);
    // query string kept, trailing full stop not part of the link
    assert.match(html, /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/a\?x=1&amp;y=2<\/a>\. /);
    // a bracket the link opened is kept; the sentence's closing bracket isn't
    assert.match(html, /href="https:\/\/en\.wikipedia\.org\/wiki\/Cave_\(disambiguation\)"[^>]*>https:\/\/en\.wikipedia\.org\/wiki\/Cave_\(disambiguation\)<\/a>\)\./);
    assert.ok(!/<a[^>]*>1\.5<\/a>/.test(html) && !/<a[^>]*>Node\.js<\/a>/.test(html), "ordinary dotted words aren't links");
  });

  test("banner message: links can't be used to sneak in markup or scripts", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({
        bannerEnabled: true,
        bannerMessage: 'See "https://example.com/x" and <a href="javascript:alert(1)">click</a> or javascript:alert(2) <img src=x onerror=alert(3)>',
      });
    const html = res.body.bannerHtml;
    assert.ok(!html.includes("javascript:alert(1)\""), "typed <a> tags are dropped");
    assert.ok(!/href="javascript/i.test(html), "no javascript: links");
    assert.ok(!html.includes("<img") && !html.includes("onerror"), "no other tags or handlers");
    assert.match(html, /href="https:\/\/example\.com\/x"/); // quotes around a link aren't part of it
  });

  test("rejects an invalid bannerColor", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ bannerColor: "purple" });
    assert.equal(res.status, 400);
  });

  describe("maintenance mode enforcement", () => {
    before(async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ maintenanceMode: true, maintenanceMessage: "Back soon." });
      assert.equal(res.status, 200);
    });

    after(async () => {
      // Belt-and-suspenders on top of the outer after() - later tests in
      // this same describe block need it off again, immediately.
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ maintenanceMode: false });
    });

    test("blocks a member's API calls with 503 while maintenance mode is on", async () => {
      const token = await login("member1", MEMBER_PASSWORD);
      const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 503);
      assert.equal(res.body.maintenance, true);
      assert.equal(res.body.error, "Back soon.");
    });

    test("blocks an unauthenticated API call too", async () => {
      const res = await request(app).get("/api/cave-database");
      assert.equal(res.status, 503);
    });

    test("does NOT block a webmaster's API calls", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 200);
    });

    test("does NOT block an admin's API calls", async () => {
      await seedUser({ username: "maintenanceadmin", password: "MaintenanceAdminPass123!", role: "admin" });
      const token = await login("maintenanceadmin", "MaintenanceAdminPass123!");
      const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 200);
    });

    test("login and site-status stay reachable during maintenance mode", async () => {
      const loginRes = await request(app).post("/api/login").send({ username: "member1", password: MEMBER_PASSWORD });
      assert.equal(loginRes.status, 200);

      const statusRes = await request(app).get("/api/site-status");
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.maintenanceMode, true);
    });

    test("GET / serves the maintenance page instead of the app", async () => {
      const res = await request(app).get("/");
      assert.equal(res.status, 200);
      assert.match(res.text, /Under Construction/);
    });

    test("GET /portal always serves the real app, maintenance mode or not", async () => {
      const res = await request(app).get("/portal");
      assert.equal(res.status, 200);
      assert.match(res.text, /Florida Cave Survey/);
      assert.ok(!/Under Construction/.test(res.text));
    });
  });

  test("GET / serves the real app when maintenance mode is off", async () => {
    const res = await request(app).get("/");
    assert.equal(res.status, 200);
    assert.ok(!/Under Construction/.test(res.text));
  });

  describe("scheduled maintenance window", () => {
    after(async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ scheduledMaintenanceStart: "", scheduledMaintenanceEnd: "" });
    });

    test("a window covering right now makes maintenance active automatically, without touching the manual toggle", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const start = new Date(Date.now() - 60_000).toISOString();
      const end = new Date(Date.now() + 60_000).toISOString();
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ scheduledMaintenanceStart: start, scheduledMaintenanceEnd: end });
      assert.equal(res.status, 200);
      assert.equal(res.body.maintenanceMode, false);
      assert.equal(res.body.maintenanceActive, true);

      const statusRes = await request(app).get("/api/site-status");
      assert.equal(statusRes.body.maintenanceActive, true);

      // and it actually gates API calls, same as the manual toggle
      const memberToken = await login("member1", MEMBER_PASSWORD);
      const gatedRes = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${memberToken}`);
      assert.equal(gatedRes.status, 503);
    });

    test("a window entirely in the future does not activate maintenance yet", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const start = new Date(Date.now() + 3600_000).toISOString();
      const end = new Date(Date.now() + 7200_000).toISOString();
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ scheduledMaintenanceStart: start, scheduledMaintenanceEnd: end });
      assert.equal(res.status, 200);
      assert.equal(res.body.maintenanceActive, false);
    });

    test("rejects a start that is not before the end", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const now = new Date().toISOString();
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ scheduledMaintenanceStart: now, scheduledMaintenanceEnd: now });
      assert.equal(res.status, 400);
    });

    test("rejects setting only a start without an end", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ scheduledMaintenanceStart: new Date().toISOString() });
      assert.equal(res.status, 400);
    });
  });

  describe("read-only mode", () => {
    before(async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ readOnlyMode: true, readOnlyMessage: "No new submissions right now." });
      assert.equal(res.status, 200);
    });

    after(async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ readOnlyMode: false, readOnlyMessage: "" });
    });

    test("blocks a member from submitting a new cave proposal", async () => {
      const token = await login("member1", MEMBER_PASSWORD);
      const res = await request(app)
        .post("/api/pending-submissions")
        .set("Authorization", `Bearer ${token}`)
        .send({ type: "new_cave", caveId: "FROTEMP", state: "FL", county: "AL", proposedData: { name: "Read Only Test Cave" } });
      assert.equal(res.status, 403);
      assert.equal(res.body.readOnly, true);
      assert.equal(res.body.error, "No new submissions right now.");
    });

    test("does not block reading the cave database", async () => {
      const token = await login("member1", MEMBER_PASSWORD);
      const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 200);
    });

    test("does not block a webmaster from writing directly to the cave database", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/save-cave-database")
        .set("Authorization", `Bearer ${token}`)
        .send({ action: "createNew", cave: { state: "FL", county: "RO", name: "Webmaster Still Writes During Read-Only" } });
      assert.equal(res.status, 200);
    });
  });

  describe("hidden tabs", () => {
    after(async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ hiddenTabs: [] });
    });

    test("rejects a non-array value", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ hiddenTabs: "statistics" });
      assert.equal(res.status, 400);
    });

    test("rejects a tab ID that isn't on the hideable list", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ hiddenTabs: ["statistics", "not-a-real-tab"] });
      assert.equal(res.status, 400);
    });

    // Account Management and Website Management must never be hideable -
    // hiding Website Management would remove the only way to ever un-hide
    // anything again.
    test("rejects account-management and website-management specifically", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      for (const tabId of ["account-management", "website-management"]) {
        const res = await request(app)
          .post("/api/site-config")
          .set("Authorization", `Bearer ${token}`)
          .send({ hiddenTabs: [tabId] });
        assert.equal(res.status, 400, `${tabId} should be rejected`);
      }
    });

    test("accepts a valid list, dedupes it, and GET /api/site-status reflects it", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const postRes = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ hiddenTabs: ["statistics", "map-tab", "statistics"] });
      assert.equal(postRes.status, 200);
      assert.deepEqual(postRes.body.hiddenTabs.sort(), ["map-tab", "statistics"]);

      const statusRes = await request(app).get("/api/site-status");
      assert.equal(statusRes.status, 200);
      assert.deepEqual(statusRes.body.hiddenTabs.sort(), ["map-tab", "statistics"]);
    });

    test("an empty list means every tab is visible again", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ hiddenTabs: [] });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.hiddenTabs, []);
    });
  });

  describe("configurable login lockout policy", () => {
    before(async () => {
      await seedUser({ username: "lockoutconfigtest", password: "LockoutConfigPass123!", role: "member" });
    });

    after(async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ loginLockoutThreshold: 5, loginLockoutMinutes: 15 });
    });

    test("rejects an out-of-range threshold", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ loginLockoutThreshold: 1 });
      assert.equal(res.status, 400);
    });

    test("rejects an out-of-range lockout window", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ loginLockoutMinutes: 0 });
      assert.equal(res.status, 400);
    });

    test("a lowered threshold takes effect immediately on the next failed login", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const configRes = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ loginLockoutThreshold: 3, loginLockoutMinutes: 15 });
      assert.equal(configRes.status, 200);

      for (let i = 0; i < 3; i++) {
        await request(app).post("/api/login").send({ username: "lockoutconfigtest", password: "WrongPassword!" });
      }
      const res = await request(app)
        .post("/api/login")
        .send({ username: "lockoutconfigtest", password: "LockoutConfigPass123!" });
      assert.equal(res.status, 429);
      assert.match(res.body.error, /15 minutes/);
    });
  });

  describe("GET /api/site-config (webmaster full view) and /api/backup-now", () => {
    test("GET /api/site-config requires webmaster", async () => {
      const token = await login("member1", MEMBER_PASSWORD);
      const res = await request(app).get("/api/site-config").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 403);
    });

    test("GET /api/site-config includes the login lockout policy; GET /api/site-status does not", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const fullRes = await request(app).get("/api/site-config").set("Authorization", `Bearer ${token}`);
      assert.equal(fullRes.status, 200);
      assert.equal(typeof fullRes.body.loginLockoutThreshold, "number");
      assert.equal(typeof fullRes.body.loginLockoutMinutes, "number");

      const publicRes = await request(app).get("/api/site-status");
      assert.equal(publicRes.body.loginLockoutThreshold, undefined);
      assert.equal(publicRes.body.loginLockoutMinutes, undefined);
    });

    test("GET /api/backup-now requires webmaster", async () => {
      const token = await login("member1", MEMBER_PASSWORD);
      const res = await request(app).get("/api/backup-now").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 403);
    });

    test("GET /api/backup-now returns a downloadable JSON snapshot with the expected shape", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app).get("/api/backup-now").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-disposition"], /attachment; filename="fcs-backup-\d{4}-\d{2}-\d{2}\.json"/);
      const body = JSON.parse(res.text);
      assert.ok(body.exportedAt);
      assert.ok(Array.isArray(body.users));
      assert.ok(Array.isArray(body.caveDatabase));
      assert.ok(Array.isArray(body.pendingSubmissions));
      assert.ok(body.siteConfig);
    });
  });

  describe("GET /api/diagnostics/storage-paths", () => {
    test("requires webmaster", async () => {
      const token = await login("member1", MEMBER_PASSWORD);
      const res = await request(app).get("/api/diagnostics/storage-paths").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 403);
    });

    test("reports app root and resolved paths for every storage directory, with file names but never content", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app).get("/api/diagnostics/storage-paths").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.appRoot === "string" && res.body.appRoot.length > 0);
      assert.ok(typeof res.body.nodeProcessCwd === "string" && res.body.nodeProcessCwd.length > 0);

      for (const key of ["narratives", "caveMaps", "cavePictures", "data"]) {
        const dir = res.body.directories[key];
        assert.ok(dir, `missing directories.${key}`);
        assert.equal(typeof dir.resolvedPath, "string");
        assert.equal(typeof dir.exists, "boolean");
        if (dir.exists) {
          assert.equal(typeof dir.entryCount, "number");
          assert.ok(Array.isArray(dir.sampleEntries));
          assert.ok(dir.sampleEntries.length <= 25);
        }
      }
    });
  });
});

describe("site updates", () => {
  test("require a login", async () => {
    const res = await request(app).get("/api/site-updates");
    assert.equal(res.status, 401);
  });

  test("lists valid updates newest first, with nothing seen yet for a new account", async () => {
    await seedUser({ username: "updates-reader", password: MEMBER_PASSWORD, role: "member" });
    const token = await login("updates-reader", MEMBER_PASSWORD);
    const res = await request(app).get("/api/site-updates").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updates.map((u) => u.id), ["newest", "middle", "older"]);
    assert.equal(res.body.lastSeenUpdateId, null);
  });

  test("closing the card records the newest seen update, and never moves backwards", async () => {
    const token = await login("updates-reader", MEMBER_PASSWORD);
    const auth = { Authorization: `Bearer ${token}` };

    const bad = await request(app).post("/api/site-updates/seen").set(auth).send({ id: "no-such-update" });
    assert.equal(bad.status, 400);

    const seen = await request(app).post("/api/site-updates/seen").set(auth).send({ id: "newest" });
    assert.equal(seen.status, 200);
    let res = await request(app).get("/api/site-updates").set(auth);
    assert.equal(res.body.lastSeenUpdateId, "newest");
    assert.equal(res.body.lastSeenUpdateDate, "2026-03-01");

    await request(app).post("/api/site-updates/seen").set(auth).send({ id: "older" });
    res = await request(app).get("/api/site-updates").set(auth);
    assert.equal(res.body.lastSeenUpdateId, "newest");
  });

  test("hides a webmasterOnly update from a member", async () => {
    const token = await login("updates-reader", MEMBER_PASSWORD);
    const res = await request(app).get("/api/site-updates").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.updates.some((u) => u.id === "webmaster-secret"));
  });

  test("hides a webmasterOnly update from an admin too - only a webmaster sees it", async () => {
    await seedUser({ username: "updates-admin", password: MEMBER_PASSWORD, role: "admin" });
    const token = await login("updates-admin", MEMBER_PASSWORD);
    const res = await request(app).get("/api/site-updates").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.updates.some((u) => u.id === "webmaster-secret"));
  });

  test("shows a webmasterOnly update to a webmaster, newest first", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/site-updates").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.updates[0].id, "webmaster-secret");
  });

  describe("toggling an update's webmasterOnly flag", () => {
    test("requires a webmaster", async () => {
      const token = await login("updates-reader", MEMBER_PASSWORD);
      const res = await request(app)
        .post("/api/site-updates/visibility")
        .set("Authorization", `Bearer ${token}`)
        .send({ id: "older", webmasterOnly: true });
      assert.equal(res.status, 403);
    });

    test("rejects a missing id or a non-boolean webmasterOnly", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const auth = { Authorization: `Bearer ${token}` };
      const noId = await request(app).post("/api/site-updates/visibility").set(auth).send({ webmasterOnly: true });
      assert.equal(noId.status, 400);
      const badFlag = await request(app)
        .post("/api/site-updates/visibility")
        .set(auth)
        .send({ id: "older", webmasterOnly: "yes" });
      assert.equal(badFlag.status, 400);
    });

    test("404s on an unknown id", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-updates/visibility")
        .set("Authorization", `Bearer ${token}`)
        .send({ id: "no-such-update", webmasterOnly: true });
      assert.equal(res.status, 404);
    });

    test("hides an update from a member and shows it again once unflagged", async () => {
      const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
      const memberToken = await login("updates-reader", MEMBER_PASSWORD);

      let res = await request(app)
        .post("/api/site-updates/visibility")
        .set("Authorization", `Bearer ${webmasterToken}`)
        .send({ id: "older", webmasterOnly: true });
      assert.equal(res.status, 200);

      let memberRes = await request(app).get("/api/site-updates").set("Authorization", `Bearer ${memberToken}`);
      assert.ok(!memberRes.body.updates.some((u) => u.id === "older"));

      res = await request(app)
        .post("/api/site-updates/visibility")
        .set("Authorization", `Bearer ${webmasterToken}`)
        .send({ id: "older", webmasterOnly: false });
      assert.equal(res.status, 200);

      memberRes = await request(app).get("/api/site-updates").set("Authorization", `Bearer ${memberToken}`);
      assert.ok(memberRes.body.updates.some((u) => u.id === "older"));
    });
  });

  test("the shipped config/site-updates.json is valid", () => {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "site-updates.json"), "utf8"));
    assert.ok(Array.isArray(list) && list.length > 0);
    const ids = new Set();
    for (const u of list) {
      assert.equal(typeof u.id, "string");
      assert.ok(!ids.has(u.id), `duplicate update id ${u.id}`);
      ids.add(u.id);
      assert.match(u.date, /^\d{4}-\d{2}-\d{2}$/, `bad date on ${u.id}`);
      assert.equal(typeof u.title, "string");
      assert.ok(Array.isArray(u.changes) && u.changes.every((c) => typeof c === "string"), `bad changes on ${u.id}`);
    }
  });
});

describe("feature requests and bug reports", () => {
  test("require a login", async () => {
    const res = await request(app).post("/api/feedback").send({ type: "bug", title: "x", description: "y" });
    assert.equal(res.status, 401);
  });

  test("validate the type, title and description", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const auth = { Authorization: `Bearer ${token}` };
    for (const body of [
      { type: "complaint", title: "t", description: "d" },
      { type: "bug", title: "   ", description: "d" },
      { type: "bug", title: "t".repeat(151), description: "d" },
      { type: "feature", title: "t", description: "" },
    ]) {
      const res = await request(app).post("/api/feedback").set(auth).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("members see only their own items; webmasters see all and can manage them", async () => {
    await seedUser({ username: "feedback-other", password: MEMBER_PASSWORD, role: "member" });
    const member = { Authorization: `Bearer ${await login("member1", MEMBER_PASSWORD)}` };
    const other = { Authorization: `Bearer ${await login("feedback-other", MEMBER_PASSWORD)}` };
    const webmaster = { Authorization: `Bearer ${await login("webmaster1", WEBMASTER_PASSWORD)}` };

    const sent = await request(app).post("/api/feedback").set(member)
      .send({ type: "bug", title: "  Markers vanish  ", description: "After filtering by county." });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.item.title, "Markers vanish");
    assert.equal(sent.body.item.status, "new");
    await request(app).post("/api/feedback").set(other).send({ type: "feature", title: "PDF export", description: "Please." });

    const mine = await request(app).get("/api/feedback").set(member);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.canManage, false);
    assert.deepEqual(mine.body.items.map((f) => f.title), ["Markers vanish"]);
    assert.equal(mine.body.items[0].userAgent, undefined);

    const all = await request(app).get("/api/feedback").set(webmaster);
    assert.equal(all.body.canManage, true);
    assert.equal(all.body.items.length, 2);

    const id = sent.body.item.id;
    assert.equal((await request(app).patch(`/api/feedback/${id}`).set(member).send({ status: "done" })).status, 403);
    assert.equal((await request(app).patch(`/api/feedback/${id}`).set(webmaster).send({ status: "nope" })).status, 400);
    const patched = await request(app).patch(`/api/feedback/${id}`).set(webmaster).send({ status: "planned", response: "Thanks, on the list." });
    assert.equal(patched.status, 200);
    const mineAfter = await request(app).get("/api/feedback").set(member);
    assert.equal(mineAfter.body.items[0].status, "planned");
    assert.equal(mineAfter.body.items[0].response, "Thanks, on the list.");

    assert.equal((await request(app).delete(`/api/feedback/${id}`).set(member)).status, 403);
    assert.equal((await request(app).delete(`/api/feedback/${id}`).set(webmaster)).status, 200);
    assert.equal((await request(app).get("/api/feedback").set(member)).body.items.length, 0);
  });
});

describe("login IP history", () => {
  test("moves this login's address to the end (most recent) and keeps at most 50", async () => {
    await seedUser({ username: "ip-history", password: MEMBER_PASSWORD, role: "member" });
    // What supertest's requests arrive as
    const res0 = await request(app).post("/api/login").send({ username: "ip-history", password: MEMBER_PASSWORD });
    assert.equal(res0.status, 200);
    let users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const myIP = users.find((u) => u.username === "ip-history").loginIPs.slice(-1)[0];

    // Pretend there's a long history with this address near the start
    const old = Array.from({ length: 60 }, (_, i) => `2600:387:f:d1a::${i.toString(16)}`);
    users.find((u) => u.username === "ip-history").loginIPs = [old[0], myIP, ...old.slice(1)];
    fs.writeFileSync(usersFilePath(), JSON.stringify(users, null, 2));

    await login("ip-history", MEMBER_PASSWORD);
    users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const ips = users.find((u) => u.username === "ip-history").loginIPs;
    assert.equal(ips.length, 50);
    assert.equal(ips[ips.length - 1], myIP);
    assert.equal(ips.filter((ip) => ip === myIP).length, 1);
  });
});

describe("membership dues", () => {
  const dues = require("../lib/dues");
  // A date N days before today (Eastern), as YYYY-MM-DD
  const daysAgo = (n) => {
    const [y, m, d] = dues.todayISO().split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
  };
  let wm, auth;
  before(async () => {
    wm = { Authorization: `Bearer ${await login("webmaster1", WEBMASTER_PASSWORD)}` };
    for (const u of ["dues-current", "dues-expired", "dues-soon", "dues-none"]) {
      await seedUser({ username: u, password: MEMBER_PASSWORD, role: "member" });
    }
    auth = async (u) => ({ Authorization: `Bearer ${await login(u, MEMBER_PASSWORD)}` });
  });

  test("settings default to $15, a 30-day reminder and blocking off; webmaster only", async () => {
    const res = await request(app).get("/api/dues/settings").set(wm);
    assert.equal(res.status, 200);
    assert.equal(res.body.duesAmount, 15);
    assert.equal(res.body.duesReminderDays, 30);
    assert.equal(res.body.duesEnforcement, false);
    assert.match(res.body.reminderUrl, /\/api\/dues\/run-reminders\?key=[0-9a-f]{32}$/);
    assert.equal((await request(app).get("/api/dues/settings").set(await auth("dues-none"))).status, 403);
    assert.equal((await request(app).post("/api/dues/settings").set(wm).send({ duesAmount: -1 })).status, 400);
    const changed = await request(app).post("/api/dues/settings").set(wm).send({ duesAmount: 20 });
    assert.equal(changed.body.duesAmount, 20);
    await request(app).post("/api/dues/settings").set(wm).send({ duesAmount: 15 });
  });

  test("recording a payment makes the membership good for a year", async () => {
    const today = dues.todayISO();
    const res = await request(app).post("/api/users/dues-current/dues/payments").set(wm).send({ paidOn: today, method: "paypal" });
    assert.equal(res.status, 201);
    assert.equal(res.body.dues.state, "paid");
    assert.equal(res.body.dues.expires, dues.addOneYear(today));
    assert.equal(res.body.dues.payments[0].amount, 15); // defaults to the current price
    const mine = await request(app).get("/api/my-membership").set(await auth("dues-current"));
    assert.equal(mine.body.state, "paid");
    assert.ok(mine.body.payLink.startsWith("https://www.paypal.com/"));
  });

  test("rejects bad payments, and payments for admins/webmasters", async () => {
    const future = dues.addOneYear(dues.todayISO());
    assert.equal((await request(app).post("/api/users/dues-current/dues/payments").set(wm).send({ paidOn: future })).status, 400);
    assert.equal((await request(app).post("/api/users/dues-current/dues/payments").set(wm).send({ paidOn: "2026-02-30" })).status, 400);
    assert.equal((await request(app).post("/api/users/dues-current/dues/payments").set(wm).send({ paidOn: daysAgo(1), method: "bitcoin" })).status, 400);
    assert.equal((await request(app).post("/api/users/webmaster1/dues/payments").set(wm).send({ paidOn: daysAgo(1) })).status, 400);
    assert.equal((await request(app).post("/api/users/dues-current/dues/payments").set(await auth("dues-none")).send({ paidOn: daysAgo(1) })).status, 403);
    const mine = await request(app).get("/api/my-membership").set(wm);
    assert.equal(mine.body.state, "exempt");
  });

  test("the dues email only goes to members whose membership has expired", async () => {
    assert.equal((await request(app).post("/api/users/dues-current/dues/notice").set(wm)).status, 409);
    assert.equal((await request(app).post("/api/users/dues-none/dues/notice").set(wm)).status, 409);
    const rec = await request(app).post("/api/users/dues-expired/dues/payments").set(wm).send({ paidOn: daysAgo(400) });
    assert.equal(rec.body.dues.state, "expired");
    const sent = await request(app).post("/api/users/dues-expired/dues/notice").set(wm);
    assert.equal(sent.status, 200);
    assert.ok(sent.body.dues.noticeSentAt);
  });

  test("automatic reminders go out once per membership year", async () => {
    await request(app).post("/api/users/dues-soon/dues/payments").set(wm).send({ paidOn: daysAgo(355) });
    const first = await app.runDuesReminders("http://localhost");
    assert.equal(first.sent, 1);
    const again = await app.runDuesReminders("http://localhost");
    assert.equal(again.sent, 0);
    const users = await request(app).get("/api/users").set(wm);
    const soon = users.body.find((u) => u.username === "dues-soon");
    assert.equal(soon.dues.state, "due-soon");
    assert.ok(soon.dues.reminderSentAt);
    assert.equal(users.body.find((u) => u.username === "webmaster1").dues.state, "exempt");
  });

  test("the scheduled-task URL needs the right key", async () => {
    assert.equal((await request(app).get("/api/dues/run-reminders?key=wrong")).status, 403);
    const { body } = await request(app).get("/api/dues/settings").set(wm);
    const key = new URL(body.reminderUrl).searchParams.get("key");
    const res = await request(app).get(`/api/dues/run-reminders?key=${key}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, 0);
  });

  test("blocking (off by default) only affects expired members, and only when switched on", async () => {
    const expired = await auth("dues-expired");
    const none = await auth("dues-none");
    assert.equal((await request(app).get("/api/cave-database").set(expired)).status, 200);

    await request(app).post("/api/dues/settings").set(wm).send({ duesEnforcement: true });
    try {
      const blocked = await request(app).get("/api/cave-database").set(expired);
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.duesExpired, true);
      assert.equal((await request(app).get("/api/my-membership").set(expired)).status, 200);
      assert.equal((await request(app).get("/api/cave-database").set(none)).status, 200);
      assert.equal((await request(app).get("/api/cave-database").set(await auth("dues-current"))).status, 200);
      assert.equal((await request(app).get("/api/cave-database").set(wm)).status, 200);
    } finally {
      await request(app).post("/api/dues/settings").set(wm).send({ duesEnforcement: false });
    }
  });

  test("deleting a mistaken payment recalculates the expiry", async () => {
    const users = await request(app).get("/api/users").set(wm);
    const cur = users.body.find((u) => u.username === "dues-current");
    const id = cur.dues.payments[0].id;
    const res = await request(app).delete(`/api/users/dues-current/dues/payments/${id}`).set(wm);
    assert.equal(res.status, 200);
    assert.equal(res.body.dues.state, "none");
    const logs = await request(app).get("/api/security-logs").set(wm);
    assert.ok(logs.body.some((l) => l.action === "Dues Payment Deleted" && l.username === "dues-current"));
  });
});

describe("treasurer", () => {
  let wm;
  const auth = async (u) => ({ Authorization: `Bearer ${await login(u, MEMBER_PASSWORD)}` });
  before(async () => {
    wm = { Authorization: `Bearer ${await login("webmaster1", WEBMASTER_PASSWORD)}` };
    await seedUser({ username: "treasurer1", password: MEMBER_PASSWORD, role: "member" });
    await seedUser({ username: "new-signup", password: MEMBER_PASSWORD, role: "member", status: "pending" });
    await seedUser({ username: "an-admin", password: MEMBER_PASSWORD, role: "admin" });
  });

  test("only a webmaster can grant Treasurer access", async () => {
    const t = await auth("treasurer1");
    assert.equal((await request(app).post("/api/users/treasurer1/treasurer").set(t).send({ isTreasurer: true })).status, 403);
    assert.equal((await request(app).get("/api/dues/members").set(t)).status, 403);
    assert.equal((await request(app).post("/api/users/webmaster1/treasurer").set(wm).send({ isTreasurer: true })).status, 400);
    const res = await request(app).post("/api/users/treasurer1/treasurer").set(wm).send({ isTreasurer: true });
    assert.equal(res.status, 200);
    const loginRes = await request(app).post("/api/login").send({ username: "treasurer1", password: MEMBER_PASSWORD });
    assert.equal(loginRes.body.isTreasurer, true);
  });

  test("a Treasurer can list members, record payments and approve accounts", async () => {
    const t = await auth("treasurer1");
    const list = await request(app).get("/api/dues/members").set(t);
    assert.equal(list.status, 200);
    assert.ok(list.body.members.every((m) => m.username !== "webmaster1" && m.username !== "an-admin"));
    assert.ok(list.body.members.some((m) => m.username === "new-signup" && m.status === "pending"));

    const pay = await request(app).post("/api/users/new-signup/dues/payments").set(t).send({ paidOn: require("../lib/dues").todayISO() });
    assert.equal(pay.status, 201);
    const act = await request(app).post("/api/dues/members/new-signup/status").set(t).send({ active: true });
    assert.equal(act.status, 200);
    assert.equal(act.body.status, "active");
    assert.equal((await request(app).post("/api/login").send({ username: "new-signup", password: MEMBER_PASSWORD })).status, 200);

    const settings = await request(app).get("/api/dues/settings").set(t);
    assert.equal(settings.status, 200);
    assert.equal(settings.body.reminderUrl, null); // the scheduled-task link stays webmaster-only
  });

  test("a Treasurer can change the dues price, but not the other dues settings", async () => {
    const t = await auth("treasurer1");
    const res = await request(app).post("/api/dues/settings").set(t).send({ duesAmount: 17.5 });
    assert.equal(res.status, 200);
    assert.equal(res.body.duesAmount, 17.5);
    assert.equal((await request(app).post("/api/dues/settings").set(t).send({ duesReminderDays: 10 })).status, 403);
    assert.equal((await request(app).post("/api/dues/settings").set(t).send({ duesAmount: 20, duesEnforcement: true })).status, 403);
    assert.equal((await request(app).get("/api/dues/settings").set(wm)).body.duesAmount, 17.5);
    await request(app).post("/api/dues/settings").set(wm).send({ duesAmount: 15 });
  });

  test("a Treasurer can't do webmaster-only things", async () => {
    const t = await auth("treasurer1");
    assert.equal((await request(app).get("/api/users").set(t)).status, 403);
    assert.equal((await request(app).post("/api/dues/settings").set(t).send({ duesEnforcement: true })).status, 403);
    assert.equal((await request(app).post("/api/dues/members/an-admin/status").set(t).send({ active: false })).status, 403);
    assert.equal((await request(app).post("/api/dues/members/webmaster1/status").set(t).send({ active: false })).status, 403);
    assert.equal((await request(app).post("/api/dues/members/treasurer1/status").set(t).send({ active: false })).status, 400);
    assert.equal((await request(app).get("/api/security-logs").set(t)).status, 403);
  });

  test("removing Treasurer access takes effect straight away", async () => {
    const t = await auth("treasurer1");
    await request(app).post("/api/users/treasurer1/treasurer").set(wm).send({ isTreasurer: false });
    assert.equal((await request(app).get("/api/dues/members").set(t)).status, 403);
    const logs = await request(app).get("/api/security-logs").set(wm);
    assert.ok(logs.body.some((l) => l.action === "Account Activated" && l.username === "new-signup"));
    assert.ok(logs.body.some((l) => l.action === "Treasurer Access Removed" && l.username === "treasurer1"));
  });
});

describe("Cave Jump page", () => {
  test("is always available, even in maintenance mode", async () => {
    const res = await request(app).get("/cave-jump");
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>Cave Jump/);
    const wm = { Authorization: `Bearer ${await login("webmaster1", WEBMASTER_PASSWORD)}` };
    await request(app).post("/api/site-config").set(wm).send({ maintenanceMode: true });
    try {
      const during = await request(app).get("/cave-jump");
      assert.equal(during.status, 200);
      assert.match(during.text, /<title>Cave Jump/);
      assert.equal((await request(app).get("/js/game.js")).status, 200);
    } finally {
      await request(app).post("/api/site-config").set(wm).send({ maintenanceMode: false });
    }
  });
});

describe("Cave Jump leaderboard", () => {
  const post = (h, body) => request(app).post("/api/cave-jump/scores").set(h).send(body);
  let wm;
  before(async () => {
    wm = { Authorization: `Bearer ${await login("webmaster1", WEBMASTER_PASSWORD)}` };
    for (let i = 1; i <= 12; i++) await seedUser({ username: `jumper${i}`, password: MEMBER_PASSWORD, role: "member" });
  });

  test("anyone can see the board; only logged-in players can add to it", async () => {
    const res = await request(app).get("/api/cave-jump/leaderboard");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.top));
    assert.equal(res.body.you, null);
    assert.equal((await request(app).post("/api/cave-jump/scores").send({ score: 10, seconds: 5 })).status, 401);
  });

  test("keeps each player's best score under their username, top 10 only", async () => {
    for (let i = 1; i <= 12; i++) {
      const h = { Authorization: `Bearer ${await login(`jumper${i}`, MEMBER_PASSWORD)}` };
      const r = await post(h, { score: i * 100, seconds: 60 });
      assert.equal(r.status, 200);
      assert.equal(r.body.isNewBest, true);
    }
    const h1 = { Authorization: `Bearer ${await login("jumper12", MEMBER_PASSWORD)}` };
    const lower = await post(h1, { score: 50, seconds: 60 });
    assert.equal(lower.body.isNewBest, false);
    assert.equal(lower.body.you.best, 1200);
    assert.equal(lower.body.you.rank, 1);

    const board = (await request(app).get("/api/cave-jump/leaderboard")).body;
    assert.equal(board.top.length, 10);
    assert.deepEqual(board.top.slice(0, 3).map((e) => [e.rank, e.name, e.score]),
      [[1, "jumper12", 1200], [2, "jumper11", 1100], [3, "jumper10", 1000]]);
    assert.equal(board.top[9].name, "jumper3");
    assert.equal(board.top[0].id, undefined); // account ids only go to webmasters
  });

  test("rejects scores that don't fit the run", async () => {
    const h = { Authorization: `Bearer ${await login("jumper1", MEMBER_PASSWORD)}` };
    assert.equal((await post(h, { score: 100000, seconds: 10 })).status, 400);
    assert.equal((await post(h, { score: 1.5, seconds: 10 })).status, 400);
    assert.equal((await post(h, { score: 100, seconds: 0 })).status, 400);
    assert.equal((await post(h, { score: -1, seconds: 10 })).status, 400);
  });

  test("a webmaster can remove a score", async () => {
    const board = (await request(app).get("/api/cave-jump/leaderboard").set(wm)).body;
    assert.equal(board.canManage, true);
    const top = board.top[0];
    const h = { Authorization: `Bearer ${await login("jumper1", MEMBER_PASSWORD)}` };
    assert.equal((await request(app).delete(`/api/cave-jump/scores/${top.id}`).set(h)).status, 403);
    const res = await request(app).delete(`/api/cave-jump/scores/${top.id}`).set(wm);
    assert.equal(res.status, 200);
    assert.equal(res.body.top[0].name, "jumper11");
  });

  test("the board still works in maintenance mode", async () => {
    await request(app).post("/api/site-config").set(wm).send({ maintenanceMode: true });
    try {
      assert.equal((await request(app).get("/api/cave-jump/leaderboard")).status, 200);
    } finally {
      await request(app).post("/api/site-config").set(wm).send({ maintenanceMode: false });
    }
  });
});

describe("legal first and last names", () => {
  test("sign-up requires a first and last name and stores them", async () => {
    const base = { username: "named-signup", email: "named-signup@example.com", password: "SomeStrongPass123!", states: ["FL"] };
    assert.equal((await request(app).post("/api/create-account").send(base)).status, 400);
    assert.equal((await request(app).post("/api/create-account").send({ ...base, firstName: "Ann", lastName: "<b>x</b>" })).status, 400);
    const ok = await request(app).post("/api/create-account").send({ ...base, firstName: "  Mary-Jane ", lastName: "O'Neil" });
    assert.equal(ok.status, 200);
    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const u = users.find((x) => x.username === "named-signup");
    assert.equal(u.firstName, "Mary-Jane");
    assert.equal(u.lastName, "O'Neil");
    assert.equal(u.fullName, "Mary-Jane O'Neil");
  });

  test("accepts names with accents and spaces", async () => {
    const res = await request(app).post("/api/create-account").send({
      username: "named-accent", email: "named-accent@example.com", password: "SomeStrongPass123!", states: ["FL"],
      firstName: "José", lastName: "St. John",
    });
    assert.equal(res.status, 200);
  });

  test("webmasters see names and can set them on existing accounts", async () => {
    const wm = { Authorization: `Bearer ${await login("webmaster1", WEBMASTER_PASSWORD)}` };
    const list = await request(app).get("/api/users").set(wm);
    assert.equal(list.body.find((u) => u.username === "named-signup").lastName, "O'Neil");
    const res = await request(app).post("/api/users/member1/name").set(wm).send({ firstName: "Pat", lastName: "Caver" });
    assert.equal(res.status, 200);
    assert.equal(res.body.fullName, "Pat Caver");
    assert.equal((await request(app).post("/api/users/member1/name").set(wm).send({ firstName: "", lastName: "Caver" })).status, 400);
    const member = { Authorization: `Bearer ${await login("member1", MEMBER_PASSWORD)}` };
    assert.equal((await request(app).post("/api/users/member1/name").set(member).send({ firstName: "Me", lastName: "Me" })).status, 403);
  });
});

describe("email checks at sign-up", () => {
  const base = { firstName: "Em", lastName: "Check", password: "SomeStrongPass123!", states: ["FL"] };
  test("sign-up rejects disposable inboxes and typo domains", async () => {
    const d = await request(app).post("/api/create-account").send({ ...base, username: "disp1", email: "disp1@mailinator.com" });
    assert.equal(d.status, 400);
    const t = await request(app).post("/api/create-account").send({ ...base, username: "typo1", email: "typo1@gmial.com" });
    assert.equal(t.status, 400);
    assert.equal(t.body.suggestion, "typo1@gmail.com");
  });

  test("the instant check route reports problems without revealing accounts", async () => {
    const bad = await request(app).post("/api/check-email").send({ email: "x@yopmail.com" });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, false);
    const good = await request(app).post("/api/check-email").send({ email: "member1@example.com" });
    assert.deepEqual(good.body, { ok: true }); // an existing member's email looks the same as any other
  });

  test("webmaster-created accounts are checked too", async () => {
    const wm = `Bearer ${await login("webmaster1", WEBMASTER_PASSWORD)}`;
    const res = await request(app).post("/api/create-user").set("Authorization", wm)
      .send({ firstName: "A", lastName: "B", username: "wmdisp", email: "wmdisp@guerrillamail.com", password: "SomeStrongPass123!" });
    assert.equal(res.status, 400);
  });
});
