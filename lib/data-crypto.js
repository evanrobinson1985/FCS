// Encryption at rest for members' personal details and for backups.
//
// Two kinds of protection, both AES-256-GCM (authenticated encryption: a
// changed or damaged value fails to decrypt instead of decrypting to garbage):
//
// 1. Fields in users.json and pending-signups.json - email, names, NSS
//    number, IP addresses, dues payments and the like - are encrypted with
//    the server's data key (DATA_ENCRYPTION_KEY in .env), each with its own
//    random 12-byte IV. Stored as "enc:v1:<base64 of iv|tag|ciphertext>".
//    Usernames, roles, statuses, dates and password hashes stay readable: the
//    site needs them to find accounts and check logins, and password hashes
//    are already one-way. The server decrypts on reading and encrypts on
//    saving, so the rest of the code sees ordinary values; a file written
//    before this (plain values) still reads fine and is encrypted on the next
//    save.
//
// 2. Whole files - backups - in one of two forms:
//    - with the server's data key ("FCSENC1" header), for the backups the
//      site keeps on its own disk;
//    - with a passphrase ("FCSBKP1" header; key derived with scrypt and a
//      random salt), for a backup downloaded to keep elsewhere, so it can be
//      restored on another server with a different data key.
//
// Losing DATA_ENCRYPTION_KEY means losing the encrypted fields (passwords
// still work - they're hashes - but emails and names are gone), so keep a
// copy of it somewhere safe, apart from the server, such as a password
// manager. A downloaded backup only needs its passphrase.

const crypto = require("crypto");

const FIELD_PREFIX = "enc:v1:";
const KEY_MAGIC = Buffer.from("FCSENC1\n");
const PASS_MAGIC = Buffer.from("FCSBKP1\n");
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// The account fields that are encrypted. Anything else on an account stays
// as it is.
const USER_FIELDS = [
  "email", "firstName", "lastName", "fullName", "nssNumber", "phone",
  "loginIPs", "signupIP", "restrictedIP", "restrictionLog", "duesPayments",
];

// DATA_ENCRYPTION_KEY: 64 hex characters (32 bytes)
function parseKey(value) {
  const s = String(value || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return null;
  return Buffer.from(s, "hex");
}

function encryptValue(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return FIELD_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

const isEncryptedValue = (v) => typeof v === "string" && v.startsWith(FIELD_PREFIX);

function decryptValue(key, stored) {
  if (!isEncryptedValue(stored)) return stored; // written before encryption: as it is
  const raw = Buffer.from(stored.slice(FIELD_PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  return JSON.parse(text);
}

function encryptRecord(key, record) {
  if (!record || typeof record !== "object") return record;
  const out = { ...record };
  for (const f of USER_FIELDS) {
    if (out[f] === undefined || out[f] === null || isEncryptedValue(out[f])) continue;
    out[f] = encryptValue(key, out[f]);
  }
  return out;
}

function decryptRecord(key, record) {
  if (!record || typeof record !== "object") return record;
  const out = { ...record };
  for (const f of USER_FIELDS) if (isEncryptedValue(out[f])) out[f] = decryptValue(key, out[f]);
  return out;
}

const encryptRecords = (key, list) => (Array.isArray(list) ? list.map((r) => encryptRecord(key, r)) : list);
const decryptRecords = (key, list) => (Array.isArray(list) ? list.map((r) => decryptRecord(key, r)) : list);
const hasPlainFields = (list) =>
  Array.isArray(list) && list.some((r) => r && USER_FIELDS.some((f) => r[f] !== undefined && r[f] !== null && !isEncryptedValue(r[f])));

// ---- whole files ----
function sealWithKey(key, buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([KEY_MAGIC, iv, cipher.getAuthTag(), ct]);
}
function openWithKey(key, buffer) {
  const b = buffer.subarray(KEY_MAGIC.length);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]);
}

function sealWithPassphrase(passphrase, buffer) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([PASS_MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}
function openWithPassphrase(passphrase, buffer) {
  const b = buffer.subarray(PASS_MAGIC.length);
  const key = crypto.scryptSync(String(passphrase), b.subarray(0, 16), 32, SCRYPT);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(16, 28));
  decipher.setAuthTag(b.subarray(28, 44));
  return Buffer.concat([decipher.update(b.subarray(44)), decipher.final()]);
}

const startsWith = (buffer, magic) => Buffer.isBuffer(buffer) && buffer.length > magic.length && buffer.subarray(0, magic.length).equals(magic);
const isKeySealed = (buffer) => startsWith(buffer, KEY_MAGIC);
const isPassphraseSealed = (buffer) => startsWith(buffer, PASS_MAGIC);

module.exports = {
  USER_FIELDS, parseKey,
  encryptValue, decryptValue, isEncryptedValue,
  encryptRecord, decryptRecord, encryptRecords, decryptRecords, hasPlainFields,
  sealWithKey, openWithKey, sealWithPassphrase, openWithPassphrase, isKeySealed, isPassphraseSealed,
};
