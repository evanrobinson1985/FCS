// Unit tests for lib/email-check.js, with a fake DNS resolver (no network)
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { checkEmail } = require("../lib/email-check");

const err = (code) => Object.assign(new Error(code), { code });
// domain -> { mx: [...] | errorCode, a: [...] | errorCode }
function fakeResolver(table) {
  const look = (domain, key) => {
    const entry = table[domain];
    if (!entry) return Promise.reject(err("ENOTFOUND"));
    const v = entry[key];
    if (v === undefined) return Promise.reject(err("ENODATA"));
    if (typeof v === "string") return Promise.reject(err(v));
    return Promise.resolve(v);
  };
  return {
    resolveMx: (d) => look(d, "mx"),
    resolve4: (d) => look(d, "a"),
    resolve6: (d) => look(d, "aaaa"),
  };
}

const resolver = fakeResolver({
  "gmail.com": { mx: [{ exchange: "gmail-smtp-in.l.google.com", priority: 5 }] },
  "caves.org": { mx: [{ exchange: "mail.caves.org", priority: 10 }] },
  "a-record-only.org": { a: ["203.0.113.7"] },
  "nullmx.example": { mx: [{ exchange: ".", priority: 0 }], a: ["203.0.113.8"] },
  "nomail.example": {},
  "flaky.example": { mx: "ETIMEOUT" },
});
const check = (email) => checkEmail(email, { resolver });

describe("email check", () => {
  test("accepts real-looking addresses at domains that receive email", async () => {
    assert.deepEqual(await check("caver@gmail.com"), { ok: true });
    assert.deepEqual(await check("Someone.Else@Caves.org"), { ok: true });
    assert.deepEqual(await check("x@a-record-only.org"), { ok: true }); // standard fallback
  });

  test("rejects domains that don't exist or can't receive email", async () => {
    assert.equal((await check("me@notarealplace123.com")).ok, false);
    assert.equal((await check("me@nomail.example")).ok, false);
    assert.equal((await check("me@nullmx.example")).ok, false);
  });

  test("never blocks anyone because of our own DNS trouble", async () => {
    assert.deepEqual(await check("me@flaky.example"), { ok: true });
    // A server with no working DNS at all: every lookup "not found",
    // including gmail.com - must let addresses through, not block everyone
    const broken = fakeResolver({});
    assert.deepEqual(await checkEmail("caver@gmail.com", { resolver: broken }), { ok: true });
    assert.deepEqual(await checkEmail("me@notarealplace123.com", { resolver: broken }), { ok: true });
  });

  test("catches common typos and suggests the fix", async () => {
    const r = await check("pat.caver@gmial.com");
    assert.equal(r.ok, false);
    assert.equal(r.suggestion, "pat.caver@gmail.com");
    assert.equal((await check("pat@gmail.con")).suggestion, "pat@gmail.com");
  });

  test("rejects disposable inboxes", async () => {
    assert.equal((await check("x@mailinator.com")).ok, false);
    assert.equal((await check("x@yopmail.com")).ok, false);
    assert.match((await check("x@10minutemail.com")).reason, /permanent/);
  });

  test("rejects malformed addresses", async () => {
    for (const bad of ["", "nope", "a@b", "a@@b.com", "a b@c.com", "<x>@y.com", "a@-.com", "a@b..com"]) {
      assert.equal((await check(bad)).ok, false, bad);
    }
  });

  test("format/typo/disposable checks still apply with DNS turned off", async () => {
    assert.deepEqual(await checkEmail("me@whatever.example", { dns: false }), { ok: true });
    assert.equal((await checkEmail("me@gmial.com", { dns: false })).ok, false);
  });
});
