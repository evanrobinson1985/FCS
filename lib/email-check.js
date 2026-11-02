// Email address checks that need no verification email.
//
// What this can tell: the address is well-formed, its domain is set up to
// receive email (DNS MX records, or an address record as the standard
// fallback), it isn't a throwaway/disposable inbox service, and it isn't a
// common typo of a big provider (gmial.com -> gmail.com).
//
// What nothing can tell without sending mail: whether a particular mailbox
// at a real provider exists (e.g. made-up-name@gmail.com). Big providers
// deliberately don't reveal that, and probing their mail servers gets the
// prober's IP blacklisted - so this doesn't try.
//
// DNS problems on our side (timeouts, resolver errors) never block anyone:
// only a definite "this domain has no way to receive email" does.

const dnsPromises = require("dns").promises;

// Common disposable / throwaway inbox domains
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "mailinator.net", "mailinator.org", "guerrillamail.com", "guerrillamail.net",
  "guerrillamail.org", "guerrillamail.biz", "guerrillamail.de", "guerrillamailblock.com", "sharklasers.com",
  "grr.la", "pokemail.net", "spam4.me", "10minutemail.com", "10minutemail.net", "10minutemail.co.uk",
  "20minutemail.com", "temp-mail.org", "temp-mail.io", "tempmail.com", "tempmail.net", "tempmailo.com",
  "tempr.email", "tempail.com", "throwawaymail.com", "trashmail.com", "trashmail.net", "trashmail.de",
  "yopmail.com", "yopmail.net", "yopmail.fr", "getnada.com", "nada.email", "dispostable.com",
  "maildrop.cc", "mailnesia.com", "mintemail.com", "mohmal.com", "fakeinbox.com", "fakemail.net",
  "emailondeck.com", "mailcatch.com", "mytemp.email", "tempinbox.com", "spamgourmet.com",
  "mailpoof.com", "burnermail.io", "discard.email", "moakt.com", "inboxkitten.com", "emailfake.com",
  "33mail.com", "getairmail.com", "anonbox.net", "mail.tm", "1secmail.com", "1secmail.net",
  "1secmail.org", "harakirimail.com", "jetable.org", "mailexpire.com", "spambox.us", "trbvm.com",
]);

// Frequent misspellings of big providers -> the intended domain
const TYPO_DOMAINS = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com", "gamil.com": "gmail.com",
  "gnail.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gmail.cm": "gmail.com",
  "gmail.om": "gmail.com", "gmaill.com": "gmail.com", "gmali.com": "gmail.com", "gmil.com": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmal.com": "hotmail.com",
  "hotmail.co": "hotmail.com", "hotmail.con": "hotmail.com", "hotmil.com": "hotmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com", "yahoo.con": "yahoo.com",
  "yhoo.com": "yahoo.com", "outlok.com": "outlook.com", "outlook.co": "outlook.com", "outlook.con": "outlook.com",
  "outloo.com": "outlook.com", "iclod.com": "icloud.com", "icloud.co": "icloud.com", "icloud.con": "icloud.com",
  "icoud.com": "icloud.com", "aol.co": "aol.com", "aol.con": "aol.com", "comcast.ner": "comcast.net",
  "comcast.com": "comcast.net", "att.com": "att.net", "bellsouth.com": "bellsouth.net",
};

const FORMAT = /^[^\s<>"'&@]+@[^\s<>"'&@]+\.[^\s<>"'&@]+$/;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms)),
  ]);
}

// Lookup failures that definitely mean "no such record"/"no such domain"
const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

// Before rejecting an address, make sure our own DNS actually works: if a
// lookup of a domain that certainly receives email fails too, the problem
// is on our side (no DNS, broken resolver) and nobody should be blocked.
// The answer is remembered for a few minutes per resolver.
const CANARY_DOMAIN = "gmail.com";
const CANARY_TTL_MS = 5 * 60 * 1000;
const canaryCache = new WeakMap(); // resolver -> { ok, at }
async function dnsWorks(resolver, timeoutMs) {
  const hit = canaryCache.get(resolver);
  if (hit && Date.now() - hit.at < CANARY_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const mx = await withTimeout(resolver.resolveMx(CANARY_DOMAIN), timeoutMs);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch (_) {
    ok = false;
  }
  canaryCache.set(resolver, { ok, at: Date.now() });
  return ok;
}

/**
 * Checks an email address. Resolves to
 *   { ok: true }  or  { ok: false, reason, suggestion? }
 * `resolver` (for tests) needs resolveMx(domain) and resolve4/resolve6.
 */
async function checkEmail(email, { resolver = dnsPromises, timeoutMs = 4000, dns = true } = {}) {
  const value = typeof email === "string" ? email.trim() : "";
  if (!FORMAT.test(value) || value.length > 254) {
    return { ok: false, reason: "Please enter a valid email address." };
  }
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase().replace(/\.$/, "");
  if (local.length > 64 || !/^[a-z0-9.-]+$/.test(domain) || domain.split(".").some((part) => !part || part.length > 63)) {
    return { ok: false, reason: "Please enter a valid email address." };
  }

  const fix = TYPO_DOMAINS[domain];
  if (fix) {
    const suggestion = `${local}@${fix}`;
    return { ok: false, reason: `Did you mean ${suggestion}?`, suggestion };
  }
  if (DISPOSABLE_DOMAINS.has(domain) || [...DISPOSABLE_DOMAINS].some((d) => domain.endsWith("." + d))) {
    return { ok: false, reason: "Please use a permanent email address, not a temporary or disposable one." };
  }
  if (!dns) return { ok: true };

  const rejected = { ok: false, reason: `${domain} can't receive email. Please check the address for typos.` };
  const noMail = async () => ((await dnsWorks(resolver, timeoutMs)) ? rejected : { ok: true });
  try {
    const mx = await withTimeout(resolver.resolveMx(domain), timeoutMs);
    if (Array.isArray(mx) && mx.length) {
      // A "null MX" (a single record pointing at ".") means the domain
      // explicitly accepts no email (RFC 7505)
      const real = mx.filter((r) => r && r.exchange && r.exchange !== ".");
      return real.length ? { ok: true } : rejected; // a published null MX is a definite answer
    }
  } catch (err) {
    if (!NOT_FOUND.has(err.code)) return { ok: true }; // our DNS trouble: don't block
    if (err.code === "ENOTFOUND" || err.code === "NXDOMAIN") return noMail(); // no such domain
  }
  // No MX records: by the standard, mail goes to the domain's own address
  // record, so accept one of those
  for (const fn of ["resolve4", "resolve6"]) {
    try {
      const addrs = await withTimeout(resolver[fn](domain), timeoutMs);
      if (Array.isArray(addrs) && addrs.length) return { ok: true };
    } catch (err) {
      if (!NOT_FOUND.has(err.code)) return { ok: true };
    }
  }
  return noMail();
}

module.exports = { checkEmail, DISPOSABLE_DOMAINS, TYPO_DOMAINS };
