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

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fcs-test-"));

process.env.JWT_SECRET = "test-jwt-secret-not-for-real-use-0123456789abcdef";
process.env.DATA_DIR = path.join(TEST_ROOT, "data");
process.env.SUBMISSIONS_FILE = path.join(TEST_ROOT, "pending-submissions.json");
process.env.NARRATIVE_DIR = path.join(TEST_ROOT, "narratives");
process.env.CAVE_MAPS_DIR = path.join(TEST_ROOT, "cave-maps");
process.env.CAVE_PICTURES_DIR = path.join(TEST_ROOT, "cave-pictures");
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "http://localhost:3000";

const request = require("supertest");
const app = require("../server");

const WEBMASTER_PASSWORD = "WebmasterPass123!";
const MEMBER_PASSWORD = "MemberPass123!";

function usersFilePath() {
  return path.join(process.env.DATA_DIR, "users.json");
}

async function seedUser({ username, password, role, status = "active" }) {
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
  await seedUser({ username: "member1", password: MEMBER_PASSWORD, role: "member" });
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

describe("password hashing", () => {
  test("stores a bcrypt hash, never the plaintext password, on self-registration", async () => {
    const res = await request(app).post("/api/create-account").send({
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
    const res = await request(app).post("/api/create-account").send({
      username: "shortpw",
      email: "shortpw@example.com",
      password: "short1",
    });
    assert.equal(res.status, 400);
  });

  test("a freshly hashed password actually verifies on login", async () => {
    await request(app).post("/api/create-account").send({
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
