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
const { execFileSync } = require("child_process");
const bcrypt = require("bcryptjs");
const XLSX = require("xlsx");

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fcs-test-"));

process.env.JWT_SECRET = "test-jwt-secret-not-for-real-use-0123456789abcdef";
process.env.DATA_DIR = path.join(TEST_ROOT, "data");
process.env.SUBMISSIONS_FILE = path.join(TEST_ROOT, "pending-submissions.json");
process.env.NARRATIVE_DIR = path.join(TEST_ROOT, "narratives");
process.env.CAVE_MAPS_DIR = path.join(TEST_ROOT, "cave-maps");
process.env.CAVE_PICTURES_DIR = path.join(TEST_ROOT, "cave-pictures");
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "http://localhost:3000";
// Points the self-update feature (see "self-update from GitHub" below) at a
// throwaway fixture git repo, set up once real git commands are needed -
// never at the real project checkout, exactly like every data path above.
const UPDATE_REPO_DIR = path.join(TEST_ROOT, "update-repo");
process.env.UPDATE_REPO_DIR = UPDATE_REPO_DIR;

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
    const res = await request(app).post("/api/create-account").send({
      username: "newmember",
      email: "newmember@example.com",
      password: "SomeStrongPass123!",
      states: ["FL"],
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
    const res = await request(app).post("/api/create-account").send({
      username: "shortpw",
      email: "shortpw@example.com",
      password: "short1",
    });
    assert.equal(res.status, 400);
  });

  test("rejects self-registration with no state selected", async () => {
    const res = await request(app).post("/api/create-account").send({
      username: "nostateuser",
      email: "nostateuser@example.com",
      password: "SomeStrongPass123!",
      states: [],
    });
    assert.equal(res.status, 400);
  });

  test("rejects self-registration with an unrecognized state code", async () => {
    const res = await request(app).post("/api/create-account").send({
      username: "badstateuser",
      email: "badstateuser@example.com",
      password: "SomeStrongPass123!",
      states: ["ZZ"],
    });
    assert.equal(res.status, 400);
  });

  // Regression test for a stored-XSS chain: this route is unauthenticated,
  // and username/email are later rendered in the webmaster's Account
  // Management table - a username containing HTML/script syntax must never
  // be accepted in the first place (defense-in-depth alongside escaping it
  // on render).
  test("rejects a username containing HTML/script syntax", async () => {
    const res = await request(app).post("/api/create-account").send({
      username: '<img src=x onerror=alert(1)>',
      email: "xssattempt@example.com",
      password: "SomeStrongPass123!",
      states: ["FL"],
    });
    assert.equal(res.status, 400);

    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    assert.ok(!users.some((u) => u.email === "xssattempt@example.com"), "no account should have been created");
  });

  test("rejects an email address containing HTML/script syntax", async () => {
    const res = await request(app).post("/api/create-account").send({
      username: "emailxssattempt",
      email: '"><script>alert(1)</script>@example.com',
      password: "SomeStrongPass123!",
      states: ["FL"],
    });
    assert.equal(res.status, 400);
  });

  test("stores the selected states as allowedStates on the new account", async () => {
    const res = await request(app).post("/api/create-account").send({
      username: "twostateuser",
      email: "twostateuser@example.com",
      password: "SomeStrongPass123!",
      states: ["FL", "GA"],
    });
    assert.equal(res.status, 200);

    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const created = users.find((u) => u.username === "twostateuser");
    assert.deepEqual(created.allowedStates, ["FL", "GA"]);
  });

  test("a freshly hashed password actually verifies on login", async () => {
    await request(app).post("/api/create-account").send({
      username: "roundtrip",
      email: "roundtrip@example.com",
      password: "RoundTripPass123!",
      states: ["FL"],
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
describe("cave database Excel import", () => {
  function buildWorkbookBuffer(headerRow, dataRows) {
    const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  }

  const IMPORT_HEADERS = ["County", "Cave Name", "Latitude", "Longitude"];

  test("GET /api/cave-database/import-template requires admin/webmaster", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .get("/api/cave-database/import-template?state=TX")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 403);
  });

  test("GET /api/cave-database/import-template rejects an unknown state code", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .get("/api/cave-database/import-template?state=ZZ")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 400);
  });

  test("GET /api/cave-database/import-template returns a real workbook with the expected header row", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .get("/api/cave-database/import-template?state=TX")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    assert.equal(res.status, 200);

    const wb = XLSX.read(res.body, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    assert.equal(rows[0][0], "County");
    assert.ok(rows[0].includes("Cave Name"));
    assert.ok(rows[0].includes("Latitude"));
    // Example row's county code should be a real Texas county.
    assert.equal(rows[1][0], "AN");
  });

  test("POST /api/cave-database/import requires admin/webmaster", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const buffer = buildWorkbookBuffer(IMPORT_HEADERS, [["AN", "Member Attempt Cave", 31.3, -95.6]]);
    const res = await request(app)
      .post("/api/cave-database/import")
      .set("Authorization", `Bearer ${token}`)
      .field("state", "TX")
      .attach("importFile", buffer, "import.xlsx");
    assert.equal(res.status, 403);
  });

  test("rejects an unknown target state", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const buffer = buildWorkbookBuffer(IMPORT_HEADERS, [["AN", "Bad State Cave", 31.3, -95.6]]);
    const res = await request(app)
      .post("/api/cave-database/import")
      .set("Authorization", `Bearer ${token}`)
      .field("state", "ZZ")
      .attach("importFile", buffer, "import.xlsx");
    assert.equal(res.status, 400);
  });

  test("imports valid rows, assigns sequential per-county IDs, and reports per-row errors without blocking the good rows", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const buffer = buildWorkbookBuffer(IMPORT_HEADERS, [
      ["AN", "Texas Anderson Cave One", 31.3, -95.6],
      ["AN", "Texas Anderson Cave Two", 31.4, -95.7],
      ["ZZ", "Bad County Cave", 31.5, -95.8],
      ["AN", "", 31.6, -95.9],
      ["AN", "Missing Coordinates Cave", "", ""],
    ]);

    const res = await request(app)
      .post("/api/cave-database/import")
      .set("Authorization", `Bearer ${token}`)
      .field("state", "TX")
      .attach("importFile", buffer, "import.xlsx");

    assert.equal(res.status, 200);
    assert.equal(res.body.imported, 2);
    assert.equal(res.body.total, 5);

    const successRows = res.body.report.filter((r) => r.status === "success");
    const errorRows = res.body.report.filter((r) => r.status === "error");
    assert.equal(successRows.length, 2);
    assert.equal(errorRows.length, 3);
    assert.deepEqual(
      successRows.map((r) => r.caveId).sort(),
      ["TXAN001", "TXAN002"]
    );

    const dbRes = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    const imported = dbRes.body.find((c) => c.id === "TXAN001");
    assert.ok(imported);
    assert.equal(imported.state, "TX");
    assert.equal(imported.county, "AN");
    assert.equal(imported.name, "Texas Anderson Cave One");
    assert.equal(imported.latitude, 31.3);
  });

  test("reports every row as an error and writes nothing when the whole file is bad", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const dbBefore = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    const countBefore = dbBefore.body.length;

    const buffer = buildWorkbookBuffer(IMPORT_HEADERS, [["ZZ", "Totally Bad Cave", 31.3, -95.6]]);
    const res = await request(app)
      .post("/api/cave-database/import")
      .set("Authorization", `Bearer ${token}`)
      .field("state", "TX")
      .attach("importFile", buffer, "import.xlsx");

    assert.equal(res.status, 200);
    assert.equal(res.body.imported, 0);

    const dbAfter = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    assert.equal(dbAfter.body.length, countBefore, "a fully-failed import must not write anything");
  });
});

describe("allowed states (member state scoping)", () => {
  before(async () => {
    await seedUser({ username: "scopeduser", password: "ScopedPass123!", role: "member", allowedStates: ["FL"] });
  });

  test("a non-webmaster cannot change another user's allowed states", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD);
    const res = await request(app)
      .post("/api/change-user-states")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ username: "scopeduser", allowedStates: ["FL", "GA"] });
    assert.equal(res.status, 403);
  });

  test("webmaster can grant an additional state to a member", async () => {
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/change-user-states")
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ username: "scopeduser", allowedStates: ["FL", "GA"] });
    assert.equal(res.status, 200);

    const users = JSON.parse(fs.readFileSync(usersFilePath(), "utf8"));
    const updated = users.find((u) => u.username === "scopeduser");
    assert.deepEqual(updated.allowedStates, ["FL", "GA"]);
  });

  test("rejects an unrecognized state code", async () => {
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app)
      .post("/api/change-user-states")
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ username: "scopeduser", allowedStates: ["ZZ"] });
    assert.equal(res.status, 400);
  });

  test("GET /api/users reports null (unrestricted) for admin/webmaster and the real array for members", async () => {
    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/users").set("Authorization", `Bearer ${webmasterToken}`);
    assert.equal(res.status, 200);

    const wm = res.body.find((u) => u.username === "webmaster1");
    assert.equal(wm.allowedStates, null);

    const scoped = res.body.find((u) => u.username === "scopeduser");
    assert.deepEqual(scoped.allowedStates, ["FL", "GA"]);
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
        county: "01",
        submittedBy: "someone-else",
        proposedData: { name: "Submission Test Cave", county: "01", type: "Land Cave", lat: 29.1, lng: -82.1 },
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
        county: "01",
        proposedData: { name: "Member Cannot Approve Cave", county: "01", type: "Land Cave", lat: 29.2, lng: -82.2 },
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
        county: "03",
        proposedData: { name: "Approved New Cave", county: "03", type: "Land Cave", lat: 29.3, lng: -82.3 },
      });
    const submissionId = submitRes.body.submission.submissionId;

    const approveRes = await request(app)
      .patch(`/api/pending-submissions/${submissionId}`)
      .set("Authorization", `Bearer ${webmasterToken}`)
      .send({ status: "approved", approvedBy: "spoofed-approver" });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.submission.approvedBy, "webmaster1"); // never the spoofed body value
    const assignedId = approveRes.body.submission.assignedCaveId;
    assert.ok(assignedId && assignedId.startsWith("F03"), `expected an assigned F03 cave id, got ${assignedId}`);

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
        county: "05",
        proposedData: { name: "Rejected Cave", county: "05", type: "Land Cave", lat: 29.5, lng: -82.5 },
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
        county: "06",
        proposedData: { name: "Double Approve Cave", county: "06", type: "Land Cave", lat: 29.6, lng: -82.6 },
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
});

describe("cave-data routes enforce allowedStates", () => {
  let gaCaveId;

  before(async () => {
    await seedUser({ username: "flonlymember", password: "FlOnlyPass123!", role: "member", allowedStates: ["FL"] });

    // Seed one Florida cave and one Georgia cave so filtering has something
    // real to prove/disprove.
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

  test("GET /api/cave-database hides other states' caves from a scoped member", async () => {
    const token = await login("flonlymember", "FlOnlyPass123!");
    const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((c) => c.name === "Scoping Test FL Cave"), "should see the Florida cave");
    assert.ok(!res.body.some((c) => c.name === "Scoping Test GA Cave"), "should NOT see the Georgia cave");
  });

  test("GET /api/cave-database is unrestricted for webmaster regardless of state", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/cave-database").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((c) => c.name === "Scoping Test FL Cave"));
    assert.ok(res.body.some((c) => c.name === "Scoping Test GA Cave"));
  });

  test("a scoped member cannot submit a proposal for a state they aren't granted", async () => {
    const token = await login("flonlymember", "FlOnlyPass123!");
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "new_cave",
        caveId: "GATEMP2",
        state: "GA",
        county: "SC",
        proposedData: { name: "Should Be Rejected Cave", state: "GA", county: "SC" },
      });
    assert.equal(res.status, 403);
  });

  test("a scoped member can still submit for a state they are granted", async () => {
    const token = await login("flonlymember", "FlOnlyPass123!");
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "new_cave",
        caveId: "FLTEMP2",
        state: "FL",
        county: "SC",
        proposedData: { name: "Allowed Florida Submission", state: "FL", county: "SC" },
      });
    assert.equal(res.status, 200);
  });

  test("GET /api/pending-submissions hides another state's submissions from a scoped member", async () => {
    const memberToken = await login("member1", MEMBER_PASSWORD); // has FL + GA
    const submitRes = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        type: "new_cave",
        caveId: "GATEMP3",
        state: "GA",
        county: "SC",
        proposedData: { name: "GA Submission For Visibility Test", state: "GA", county: "SC" },
      });
    assert.equal(submitRes.status, 200);

    const flOnlyToken = await login("flonlymember", "FlOnlyPass123!");
    const res = await request(app).get("/api/pending-submissions").set("Authorization", `Bearer ${flOnlyToken}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.some((s) => s.caveId === "GATEMP3"), "FL-only member should not see the GA submission");

    const webmasterToken = await login("webmaster1", WEBMASTER_PASSWORD);
    const wmRes = await request(app).get("/api/pending-submissions").set("Authorization", `Bearer ${webmasterToken}`);
    assert.ok(wmRes.body.some((s) => s.caveId === "GATEMP3"), "webmaster should see every state's submissions");
  });

  // Regression test for an IDOR: an edit_cave submission's authorization
  // used to trust the client-supplied `state` field rather than the target
  // cave's real, resolved state - so a member could edit (and read back,
  // via the pending-submissions "enhance with current cave data" step) a
  // cave in a state they were never granted, just by lying about the state
  // in the request body.
  test("a scoped member cannot submit an edit_cave proposal for another state's real cave by lying about the state", async () => {
    const token = await login("flonlymember", "FlOnlyPass123!");
    const res = await request(app)
      .post("/api/pending-submissions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "edit_cave",
        caveId: gaCaveId, // a real Georgia cave - flonlymember is FL-only
        state: "FL", // the lie: claiming FL so the allowedStates check passes
        county: "SC",
        proposedData: { name: "Should Be Rejected Edit" },
      });
    assert.equal(res.status, 403, "must be rejected based on the cave's REAL state (GA), not the claimed one (FL)");
  });

  test("edit_cave submission state is resolved from the real cave, ignoring a mismatched client-supplied state", async () => {
    // member1 has both FL and GA (see the top-level seedUser call) - submits
    // an edit for the real Georgia cave while claiming state: "FL" in the
    // body. This must still succeed (member1 IS allowed GA), and the stored
    // submission must record the cave's real state, not the claimed one.
    const token = await login("member1", MEMBER_PASSWORD);
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
});

describe("website management: self-update from GitHub", () => {
  // "origin" (a bare repo standing in for GitHub) and the "production"
  // checkout server.js runs real git commands against (UPDATE_REPO_DIR, set
  // at the top of this file before server.js was required). A third clone
  // ("pusher") stands in for someone pushing a new commit to GitHub, so
  // UPDATE_REPO_DIR itself stays clean until a test explicitly pulls it in.
  const originDir = path.join(TEST_ROOT, "update-origin.git");
  const pusherDir = path.join(TEST_ROOT, "update-pusher");
  let initialCommitHash;
  let secondCommitHash;

  function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  before(() => {
    fs.mkdirSync(originDir, { recursive: true });
    git(originDir, ["init", "--bare", "-b", "main"]);

    fs.mkdirSync(UPDATE_REPO_DIR, { recursive: true });
    git(UPDATE_REPO_DIR, ["clone", originDir, "."]);
    git(UPDATE_REPO_DIR, ["config", "user.email", "test@example.com"]);
    git(UPDATE_REPO_DIR, ["config", "user.name", "Test"]);

    // A gitignored "data" file sitting right alongside the tracked code,
    // the same way data/, cave-maps/, and narratives/ sit alongside
    // server.js in the real project - this proves an update can't see or
    // touch it, since git itself is never told it exists.
    fs.writeFileSync(path.join(UPDATE_REPO_DIR, ".gitignore"), "app-data.json\n");
    fs.writeFileSync(path.join(UPDATE_REPO_DIR, "app.js"), "console.log('v1');\n");
    fs.writeFileSync(path.join(UPDATE_REPO_DIR, "app-data.json"), JSON.stringify({ marker: "untouched" }));
    git(UPDATE_REPO_DIR, ["add", "app.js", ".gitignore"]);
    git(UPDATE_REPO_DIR, ["commit", "-m", "initial commit"]);
    initialCommitHash = git(UPDATE_REPO_DIR, ["rev-parse", "HEAD"]);
    git(UPDATE_REPO_DIR, ["push", "origin", "main"]);

    fs.mkdirSync(pusherDir, { recursive: true });
    git(pusherDir, ["clone", originDir, "."]);
    git(pusherDir, ["config", "user.email", "test@example.com"]);
    git(pusherDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(pusherDir, "app.js"), "console.log('v2');\n");
    git(pusherDir, ["add", "app.js"]);
    git(pusherDir, ["commit", "-m", "bump to v2"]);
    secondCommitHash = git(pusherDir, ["rev-parse", "HEAD"]);
    git(pusherDir, ["push", "origin", "main"]);
  });

  after(async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    await request(app)
      .post("/api/site-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ autoUpdateEnabled: false, autoUpdateTime: "03:00" });
  });

  test("GET /api/update-status requires webmaster", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app).get("/api/update-status").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 403);
  });

  test("POST /api/update-now requires webmaster", async () => {
    const token = await login("member1", MEMBER_PASSWORD);
    const res = await request(app).post("/api/update-now").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 403);
  });

  test("GET /api/update-status reports the pending upstream commit without changing anything", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/update-status").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.gitAvailable, true);
    assert.equal(res.body.branch, "main");
    assert.equal(res.body.upToDate, false);
    assert.equal(res.body.commitsBehind, 1);
    assert.equal(res.body.pendingCommits.length, 1);
    assert.equal(res.body.pendingCommits[0].subject, "bump to v2");
    assert.equal(res.body.dirty, false);
    assert.equal(git(UPDATE_REPO_DIR, ["rev-parse", "HEAD"]), initialCommitHash);
  });

  test("POST /api/update-now refuses to run against a dirty tracked file, and touches nothing", async () => {
    // Locally modify the exact file the pending upstream commit changes,
    // without committing - a fast-forward-only merge must refuse this
    // rather than overwrite it.
    fs.writeFileSync(path.join(UPDATE_REPO_DIR, "app.js"), "console.log('local edit, not committed');\n");

    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).post("/api/update-now").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 500);
    assert.equal(res.body.updated, false);
    assert.ok(res.body.error, "expected a git error message explaining the refusal");

    // Nothing was touched: the local edit is exactly as left, HEAD hasn't
    // moved, and the gitignored data file is untouched.
    assert.equal(
      fs.readFileSync(path.join(UPDATE_REPO_DIR, "app.js"), "utf8"),
      "console.log('local edit, not committed');\n"
    );
    assert.equal(git(UPDATE_REPO_DIR, ["rev-parse", "HEAD"]), initialCommitHash);
    assert.equal(
      fs.readFileSync(path.join(UPDATE_REPO_DIR, "app-data.json"), "utf8"),
      JSON.stringify({ marker: "untouched" })
    );

    git(UPDATE_REPO_DIR, ["checkout", "--", "app.js"]); // clean up for the next test
  });

  test("POST /api/update-now fast-forwards to the latest commit, reports changed files, and never touches gitignored data", async () => {
    const dataBefore = fs.readFileSync(path.join(UPDATE_REPO_DIR, "app-data.json"), "utf8");

    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).post("/api/update-now").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, true);
    assert.equal(res.body.previousCommit, initialCommitHash);
    assert.equal(res.body.newCommit, secondCommitHash);
    assert.deepEqual(res.body.changedFiles, ["app.js"]);
    assert.equal(res.body.restartTriggered, true);

    assert.equal(fs.readFileSync(path.join(UPDATE_REPO_DIR, "app.js"), "utf8"), "console.log('v2');\n");
    assert.equal(git(UPDATE_REPO_DIR, ["rev-parse", "HEAD"]), secondCommitHash);
    assert.equal(fs.readFileSync(path.join(UPDATE_REPO_DIR, "app-data.json"), "utf8"), dataBefore);
    assert.ok(fs.existsSync(path.join(UPDATE_REPO_DIR, "tmp", "restart.txt")));
  });

  test("GET /api/update-status reports up to date after the update", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/update-status").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.upToDate, true);
    assert.equal(res.body.commitsBehind, 0);
  });

  test("the previous update's own tmp/restart.txt does not make the tree look dirty", async () => {
    // The update just applied wrote tmp/restart.txt as its restart signal.
    // That file is untracked (this fixture repo's own .gitignore, unlike
    // the real project's, never mentions tmp/), so this proves the dirty
    // check specifically excludes the feature's own bookkeeping file rather
    // than just happening to pass because it's ignored.
    assert.ok(fs.existsSync(path.join(UPDATE_REPO_DIR, "tmp", "restart.txt")));
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).get("/api/update-status").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.dirty, false);
  });

  test("POST /api/update-now is a no-op when already up to date", async () => {
    const token = await login("webmaster1", WEBMASTER_PASSWORD);
    const res = await request(app).post("/api/update-now").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, false);
    assert.equal(res.body.message, "Already up to date.");
  });

  describe("scheduled auto-update", () => {
    test("POST /api/site-config rejects a malformed autoUpdateTime", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ autoUpdateTime: "3am" });
      assert.equal(res.status, 400);
    });

    test("POST /api/site-config accepts and persists autoUpdateEnabled/autoUpdateTime", async () => {
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      const res = await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ autoUpdateEnabled: true, autoUpdateTime: "04:30" });
      assert.equal(res.status, 200);
      assert.equal(res.body.autoUpdateEnabled, true);
      assert.equal(res.body.autoUpdateTime, "04:30");
    });

    test("checkScheduledUpdate() applies the update once enabled and the clock matches", async () => {
      fs.writeFileSync(path.join(pusherDir, "app.js"), "console.log('v3 - scheduled');\n");
      git(pusherDir, ["add", "app.js"]);
      git(pusherDir, ["commit", "-m", "bump to v3"]);
      git(pusherDir, ["push", "origin", "main"]);

      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ autoUpdateEnabled: true, autoUpdateTime: hhmm });

      await app.locals.checkScheduledUpdate();

      assert.equal(fs.readFileSync(path.join(UPDATE_REPO_DIR, "app.js"), "utf8"), "console.log('v3 - scheduled');\n");
    });

    test("checkScheduledUpdate() does not re-apply again the same day even if called again", async () => {
      fs.writeFileSync(path.join(pusherDir, "app.js"), "console.log('v4 - should not apply yet');\n");
      git(pusherDir, ["add", "app.js"]);
      git(pusherDir, ["commit", "-m", "bump to v4"]);
      git(pusherDir, ["push", "origin", "main"]);

      await app.locals.checkScheduledUpdate();

      assert.equal(fs.readFileSync(path.join(UPDATE_REPO_DIR, "app.js"), "utf8"), "console.log('v3 - scheduled');\n");
    });

    test("checkScheduledUpdate() does nothing while autoUpdateEnabled is false", async () => {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const token = await login("webmaster1", WEBMASTER_PASSWORD);
      await request(app)
        .post("/api/site-config")
        .set("Authorization", `Bearer ${token}`)
        .send({ autoUpdateEnabled: false, autoUpdateTime: hhmm });

      await app.locals.checkScheduledUpdate();

      // Still at v3 - v4 (pushed in the previous test) never got pulled in.
      assert.equal(fs.readFileSync(path.join(UPDATE_REPO_DIR, "app.js"), "utf8"), "console.log('v3 - scheduled');\n");
    });
  });
});
