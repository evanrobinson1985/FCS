require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const sanitizeHtml = require("sanitize-html");
const nodemailer = require("nodemailer");
const app = express();
const PORT = process.env.PORT || 3000;
// Overridable so the test suite can point this at a throwaway file instead
// of the real, tracked pending-submissions.json.
const submissionsFile = process.env.SUBMISSIONS_FILE
  ? path.resolve(process.env.SUBMISSIONS_FILE)
  : path.join(__dirname, "pending-submissions.json");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const XLSX = require("xlsx");

// Private data directory. This is NEVER mounted with express.static, so nothing
// placed here (the cave database, the user list) can ever be fetched directly
// by a browser, logged in or not - only through authenticated API routes below.
// Overridable so the test suite can point it at a throwaway directory instead
// of ever touching real data.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, "users.json");
const CAVE_DB_FILE = path.join(DATA_DIR, "cave-database.json");

// State/county reference data (see scripts/generate-states-config.js). This
// is public geographic reference data, not survey data, so unlike the files
// above it lives in config/ and IS tracked in git.
const STATES_CONFIG_FILE = path.join(__dirname, "config", "states.json");

// Timestamped backups of the two data files, taken right before every write.
// These are the only copies of the cave database and the user list - a bad
// write, a bug in a future change, or an admin approving the wrong thing
// currently has no way back. This gives one.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const MAX_BACKUPS_PER_FILE = 30;

function backupDataFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return; // nothing to back up yet

    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(BACKUP_DIR, `${baseName}.${timestamp}${ext}`);
    fs.copyFileSync(filePath, backupPath);

    // Rotate: keep only the most recent MAX_BACKUPS_PER_FILE copies of this
    // particular file. ISO timestamps sort lexicographically in the same
    // order as chronologically, so a plain string sort is enough.
    const prefix = `${baseName}.`;
    const existing = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
      .sort();
    const excess = existing.length - MAX_BACKUPS_PER_FILE;
    if (excess > 0) {
      existing.slice(0, excess).forEach((f) => {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      });
    }
  } catch (err) {
    // A failed backup should never block the actual save.
    console.error(`Failed to back up ${filePath}:`, err);
  }
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error(
    "FATAL: JWT_SECRET environment variable must be set to a strong random value " +
      "(32+ characters) before starting this server. Generate one with:\n" +
      "  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n" +
      "and put it in your .env file (see .env.example). Refusing to start with a " +
      "missing or weak secret."
  );
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === "production";

// --- Outbound email (password reset) ---------------------------------------
//
// Configured entirely through env vars (see .env.example) because real
// mail delivery needs a real SMTP account - something this environment has
// no way to provision. Without SMTP_HOST/SMTP_USER/SMTP_PASS set, reset
// links are logged to the console instead of emailed, so the feature is
// still usable (by an operator watching the logs) in development.
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log("✅ SMTP configured - password reset emails will be sent for real");
} else {
  console.log(
    "⚠️ SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS in .env) - " +
      "password reset links will be logged to the console instead of emailed."
  );
}

async function sendPasswordResetEmail(user, resetUrl) {
  const subject = "Florida Cave Survey - Password Reset";
  const text =
    `Hi ${user.fullName || user.username},\n\n` +
    "A password reset was requested for your Florida Cave Survey account. " +
    "If this was you, set a new password here (this link expires in 1 hour):\n\n" +
    `${resetUrl}\n\n` +
    "If you didn't request this, you can safely ignore this email - your password will not change.";

  if (!mailTransporter) {
    console.log(`[DEV] Password reset link for ${user.email}: ${resetUrl}`);
    return;
  }

  await mailTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject,
    text,
  });
}

// Reset tokens are stored as a SHA-256 hash (not the raw token, same
// principle as never storing plaintext passwords) so a leaked users.json
// doesn't hand out working reset links. Unlike passwords these need fast
// equality lookup rather than slow verification, so bcrypt isn't the right
// tool here - a random 32-byte token has enough entropy that a fast hash is
// fine.
function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// --- Two-factor authentication (email one-time code) -----------------------
//
// Opt-in per account (see POST /api/toggle-2fa). When enabled, a successful
// password check at /api/login doesn't issue a session token yet - it emails
// a 6-digit code and returns a short-lived "pending" token instead, which
// only /api/verify-2fa and /api/resend-2fa will accept (authenticateToken
// below explicitly rejects it everywhere else, so a leaked pending token
// can't be used to skip the code step on any real route).

function generateOtpCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, "0");
}

// Same reasoning as hashResetToken above: store a fast hash, not the code
// itself, so a leaked users.json doesn't hand out a working login code.
function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function sendTwoFactorCode(user, code) {
  const subject = "Florida Cave Survey - Your Login Verification Code";
  const text =
    `Hi ${user.fullName || user.username},\n\n` +
    `Your verification code is: ${code}\n\n` +
    "This code expires in 10 minutes. If you didn't just try to log in, you " +
    "can ignore this email - your account is still protected by your password.";

  if (!mailTransporter) {
    console.log(`[DEV] Two-factor code for ${user.email}: ${code}`);
    return;
  }

  await mailTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject,
    text,
  });
}

// Verifies a short-lived pending-2FA token (issued by /api/login) and
// returns its decoded payload, or null if it's missing, expired, invalid,
// or isn't actually a pending-2FA token.
function verifyTwoFactorToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded && decoded.pending2FA ? decoded : null;
  } catch {
    return null;
  }
}

// Trust the first proxy hop so req.ip / req.secure and the X-Forwarded-* headers
// used below are accurate when this app runs behind a TLS-terminating reverse
// proxy or load balancer (the normal deployment shape for this app).
app.set("trust proxy", 1);

// Force HTTPS in production. All traffic must be encrypted end-to-end; this
// redirects any request that reached us over plain HTTP (as reported by the
// TLS-terminating proxy via X-Forwarded-Proto) to the HTTPS URL instead of
// serving it.
app.use((req, res, next) => {
  if (
    isProduction &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-proto"] !== "https"
  ) {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

// Security headers: locks down where scripts/styles may load from (mitigates
// XSS), enables HSTS so browsers refuse to downgrade this site to plain HTTP,
// and sets the other standard hardening headers (X-Frame-Options, nosniff, etc).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.quilljs.com",
          "https://cdn.jsdelivr.net",
          "https://cdnjs.cloudflare.com",
          "https://unpkg.com",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.quilljs.com",
          "https://cdn.jsdelivr.net",
          "https://cdnjs.cloudflare.com",
          "https://unpkg.com",
        ],
        fontSrc: ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "data:"],
        // Map tiles/imagery are pulled from many geographic data providers
        // (Esri, USGS National Map, Stamen, etc.) so these stay broad, but are
        // still restricted to HTTPS - see SECURITY.md for the tradeoff.
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "https:"],
        workerSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        // helmet defaults this to 'none', which is stricter than scriptSrc's
        // 'unsafe-inline' above: it specifically blocks inline event-handler
        // attributes (onclick="...", onchange="...", etc.), which this app
        // uses throughout (dozens of buttons across the page). Without this,
        // every one of those buttons is silently inert - CSP blocks the
        // handler and logs a console warning, nothing else, so it's easy to
        // miss outside of an actual browser test.
        scriptSrcAttr: ["'unsafe-inline'"],
        // helmet includes this directive by default, which tells the browser
        // to rewrite every http: subresource request on the page to https: -
        // including this app's own same-origin requests. That's correct once
        // this is actually served over HTTPS in production, but it silently
        // breaks every asset/API call when running locally over plain HTTP
        // (nothing is listening on 443, so the "upgraded" requests just fail).
        // Only send it once we're actually in production.
        "upgrade-insecure-requests": isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

// CORS: only the configured front-end origin(s) may call this API with
// credentials. Set ALLOWED_ORIGINS in .env (comma-separated) for any origin
// besides the production domain (e.g. a local dev server).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://fcs.caves.org")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin requests (no Origin header, e.g. curl or the page's own
      // fetches when served from this app) are always allowed.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Rate limiting on authentication-adjacent endpoints to blunt brute-force
// credential guessing and account-enumeration attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in a few minutes." },
  // The test suite makes far more than 10 login/registration calls across
  // its run, all from the same source as far as this IP-based limiter is
  // concerned - skip it under NODE_ENV=test so tests exercise the actual
  // per-account lockout logic in /api/login instead of tripping over this
  // unrelated global limiter. Never skipped outside of tests.
  skip: () => process.env.NODE_ENV === "test",
});

// --- Auth middleware -------------------------------------------------------

// Requires a valid, unexpired JWT on the Authorization header. Populates
// req.user with the token's payload ({ id, username, role, fullName }).
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // Fall back to a ?token= query parameter. This exists for the handful of
  // routes browsers request without any way to attach a custom header:
  // <img src>, <iframe src>, direct download links, and map-tile libraries
  // (Leaflet etc.) all issue plain GETs with no Authorization header, no
  // matter what the page's own JS does. Without this fallback, every cave
  // photo, map preview, and tile image would 401 the instant these routes
  // required a login (see the client-side withAuthToken() helper, which
  // appends this to every such URL). The header is still tried first and
  // is what every fetch()-based API call uses.
  if (!token && typeof req.query.token === "string") {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired session. Please log in again." });
    }
    // A pending-2FA token (issued by /api/login while a code is outstanding)
    // proves a correct password, not a completed login - it must never be
    // accepted here, only by /api/verify-2fa and /api/resend-2fa, which
    // check it explicitly themselves. Without this, a leaked pending token
    // could reach any authenticateToken-only route and skip the code step.
    if (decoded.pending2FA) {
      return res.status(401).json({ error: "Two-factor verification required." });
    }
    req.user = decoded;
    next();
  });
}

// Restricts a route to one of the given roles. Must run after authenticateToken.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to perform this action." });
    }
    next();
  };
}

// Returns the states a user may see/act on: `null` means unrestricted
// (every state) - always true for admin and webmaster, matching their
// existing equal footing on every other cave-data route (see
// requireRole("admin", "webmaster") throughout this file). Members are
// scoped to whatever states have been granted to their account.
function getAllowedStatesForUser(user) {
  if (!user || user.role === "admin" || user.role === "webmaster") {
    return null;
  }
  return Array.isArray(user.allowedStates) ? user.allowedStates : [];
}

app.post("/api/login", authLimiter, express.json(), async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Username and password are required" });
    }

    const users = loadUsers();
    const user = users.find((u) => u.username === username);

    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    if (user.status !== "active") {
      return res.status(403).json({ error: "This account is inactive." });
    }

    // Lock the account out temporarily after repeated failed attempts, on top
    // of the IP-based rate limiter, so a leaked/guessed username alone isn't
    // enough to brute-force a single account from many IPs.
    const LOCKOUT_THRESHOLD = 5;
    const LOCKOUT_MS = 15 * 60 * 1000;
    if (
      user.loginAttempts >= LOCKOUT_THRESHOLD &&
      user.lastFailedLogin &&
      Date.now() - new Date(user.lastFailedLogin).getTime() < LOCKOUT_MS
    ) {
      return res.status(429).json({
        error: "Too many failed login attempts. Please try again in 15 minutes.",
      });
    }

    // Check password against the stored bcrypt hash. Plaintext passwords are
    // never stored, so there is nothing to fall back to.
    const passwordMatches =
      !!user.passwordHash && (await bcrypt.compare(password, user.passwordHash));

    if (!passwordMatches) {
      user.loginAttempts = (user.loginAttempts || 0) + 1;
      user.lastFailedLogin = new Date().toISOString();
      saveUsers(users);
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Update last login and reset login attempts
    user.lastLogin = new Date().toISOString();
    user.loginAttempts = 0;
    user.lastFailedLogin = null;

    // Track login IP
    const clientIP = req.ip || req.connection.remoteAddress || "unknown";
    if (!user.loginIPs) user.loginIPs = [];
    if (!user.loginIPs.includes(clientIP)) {
      user.loginIPs.push(clientIP);
    }

    // The password is correct, but if this account has 2FA enabled that's
    // not enough to log in yet - email a code and hand back a short-lived
    // pending token instead of a real session token. The real token is only
    // issued once that code is confirmed at /api/verify-2fa.
    if (user.twoFactorEnabled) {
      const code = generateOtpCode();
      user.twoFactorCodeHash = hashOtp(code);
      user.twoFactorCodeExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      user.twoFactorAttempts = 0;
      saveUsers(users);

      try {
        await sendTwoFactorCode(user, code);
      } catch (mailErr) {
        console.error("Failed to send two-factor code:", mailErr);
        return res.status(500).json({ error: "Could not send verification code. Please try again." });
      }

      const twoFactorToken = jwt.sign(
        { username: user.username, pending2FA: true },
        JWT_SECRET,
        { expiresIn: "10m" }
      );

      return res.json({
        twoFactorRequired: true,
        twoFactorToken,
        message: "A verification code has been sent to your email.",
      });
    }

    saveUsers(users);

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.fullName,
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      success: true,
      token,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      nssNumber: user.nssNumber,
      twoFactorEnabled: !!user.twoFactorEnabled,
      allowedStates: getAllowedStatesForUser(user),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Second step of login for accounts with 2FA enabled: exchanges the pending
// token + emailed code for a real session token.
app.post("/api/verify-2fa", authLimiter, express.json(), async (req, res) => {
  try {
    const { twoFactorToken, code } = req.body;
    if (!twoFactorToken || !code) {
      return res.status(400).json({ error: "Verification token and code are required" });
    }

    const decoded = verifyTwoFactorToken(twoFactorToken);
    if (!decoded) {
      return res.status(401).json({ error: "Verification session expired. Please log in again." });
    }

    const users = loadUsers();
    const user = users.find((u) => u.username === decoded.username);
    if (!user || !user.twoFactorCodeHash || !user.twoFactorCodeExpires) {
      return res.status(400).json({ error: "No pending verification for this account. Please log in again." });
    }

    if (new Date(user.twoFactorCodeExpires) < new Date()) {
      delete user.twoFactorCodeHash;
      delete user.twoFactorCodeExpires;
      delete user.twoFactorAttempts;
      saveUsers(users);
      return res.status(401).json({ error: "Verification code expired. Please log in again." });
    }

    // Mirrors the per-account lockout on /api/login: the IP-based authLimiter
    // alone isn't enough to stop a 6-digit code from being brute-forced.
    const MAX_2FA_ATTEMPTS = 5;
    if ((user.twoFactorAttempts || 0) >= MAX_2FA_ATTEMPTS) {
      delete user.twoFactorCodeHash;
      delete user.twoFactorCodeExpires;
      delete user.twoFactorAttempts;
      saveUsers(users);
      return res.status(429).json({ error: "Too many incorrect attempts. Please log in again." });
    }

    if (hashOtp(String(code)) !== user.twoFactorCodeHash) {
      user.twoFactorAttempts = (user.twoFactorAttempts || 0) + 1;
      saveUsers(users);
      return res.status(401).json({ error: "Incorrect verification code." });
    }

    delete user.twoFactorCodeHash;
    delete user.twoFactorCodeExpires;
    delete user.twoFactorAttempts;
    saveUsers(users);

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.fullName,
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      success: true,
      token,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      nssNumber: user.nssNumber,
      twoFactorEnabled: !!user.twoFactorEnabled,
      allowedStates: getAllowedStatesForUser(user),
    });
  } catch (error) {
    console.error("2FA verification error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Re-sends a fresh code for a login already in progress (the pending token
// from /api/login identifies which account, same as verify does).
app.post("/api/resend-2fa", authLimiter, express.json(), async (req, res) => {
  try {
    const { twoFactorToken } = req.body;
    if (!twoFactorToken) {
      return res.status(400).json({ error: "Verification token is required" });
    }

    const decoded = verifyTwoFactorToken(twoFactorToken);
    if (!decoded) {
      return res.status(401).json({ error: "Verification session expired. Please log in again." });
    }

    const users = loadUsers();
    const user = users.find((u) => u.username === decoded.username);
    if (!user) {
      return res.status(400).json({ error: "No pending verification for this account." });
    }

    const code = generateOtpCode();
    user.twoFactorCodeHash = hashOtp(code);
    user.twoFactorCodeExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    user.twoFactorAttempts = 0;
    saveUsers(users);

    await sendTwoFactorCode(user, code);
    res.json({ message: "A new verification code has been sent." });
  } catch (error) {
    console.error("Resend 2FA error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Lets a logged-in user turn 2FA on or off for their own account. Turning it
// off weakens the account, so (unlike turning it on) it requires re-entering
// the current password - a hijacked session token alone isn't enough.
app.post("/api/toggle-2fa", authenticateToken, express.json(), async (req, res) => {
  try {
    const { enabled, password } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false" });
    }

    const users = loadUsers();
    const user = users.find((u) => u.username === req.user.username);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!enabled) {
      const passwordMatches =
        !!password && !!user.passwordHash && (await bcrypt.compare(password, user.passwordHash));
      if (!passwordMatches) {
        return res.status(401).json({ error: "Incorrect password." });
      }
      user.twoFactorEnabled = false;
    } else {
      user.twoFactorEnabled = true;
    }

    saveUsers(users);
    res.json({
      message: `Two-factor authentication ${enabled ? "enabled" : "disabled"}.`,
      twoFactorEnabled: user.twoFactorEnabled,
    });
  } catch (error) {
    console.error("Toggle 2FA error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, "utf-8");
      return JSON.parse(data);
    }
    return [];
  } catch (err) {
    console.error("Error loading users:", err);
    return [];
  }
}

function saveUsers(users) {
  try {
    backupDataFile(USERS_FILE);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Error saving users:", err);
  }
}

// API endpoint to get current cave database - the whole point of this route
// is that it is NOT static and DOES require a valid login, unlike the old
// setup where cave-database.js sat in the public web root and was sent to
// anyone who requested it, logged in or not. Admin/webmaster see every
// state; a member only sees caves in states they've been granted (see
// getAllowedStatesForUser) - looked up fresh per request (not cached in the
// JWT) so a webmaster revoking/granting a state takes effect immediately,
// not after the member's session happens to expire and they log in again.
app.get("/api/cave-database", authenticateToken, (req, res) => {
  const users = loadUsers();
  const user = users.find((u) => u.username === req.user.username);
  const allowed = getAllowedStatesForUser(user);

  if (allowed === null) {
    return res.json(caveDatabase);
  }

  res.json(caveDatabase.filter((cave) => allowed.includes(resolveCaveStateAndCounty(cave).state)));
});

// Per-state and nationwide cave *counts* - deliberately NOT scoped by the
// requesting user's allowedStates (unlike GET /api/cave-database above).
// A state-scoped member can already see everything about their own
// state's caves; this just adds a single aggregate number per other state
// plus a nationwide total, so they have a sense of the whole survey's
// scale without exposing any individual cave's location, name, or other
// details for a state they aren't granted - only a count.
app.get("/api/cave-database/state-counts", authenticateToken, (req, res) => {
  const counts = {};
  caveDatabase.forEach((cave) => {
    const state = resolveCaveStateAndCounty(cave).state;
    if (!state) return;
    counts[state] = (counts[state] || 0) + 1;
  });

  const states = statesConfig
    .map((s) => ({ code: s.code, name: s.name, count: counts[s.code] || 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  res.json({ total: caveDatabase.length, states });
});

const MIN_PASSWORD_LENGTH = 10;

// Transitional backward-compat default: every cave-creating route requires
// a `state`, but the client doesn't send one yet (multi-state frontend work
// lands in a later phase) - defaulting missing state to Florida keeps the
// existing, single-state UI working unmodified until it does. Once every
// client always sends `state` explicitly this default (and the two call
// sites that use it) can be removed.
const DEFAULT_STATE_CODE = "FL";

// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "httpdocs", "index.html"));
});

// Narrative photos are member content - require login to view them, same as
// the narratives themselves. This MUST be registered before the general
// httpdocs static mount below: httpdocs/cave-pictures is a subdirectory of
// httpdocs, and Express matches middleware in registration order, not by
// specificity - if the unauthenticated catch-all mount ran first, it would
// happily serve files out of cave-pictures/ itself before this auth check
// ever ran, silently defeating it.
app.use(
  "/cave-pictures",
  authenticateToken,
  express.static(path.join(__dirname, "httpdocs", "cave-pictures"))
);

// Serve static files - the public site shell (login page, styles, logo).
// Nothing sensitive lives directly under httpdocs/ any more; the cave
// database and user list live in the private data/ directory instead (see
// above), and cave-pictures/ is intercepted by the authenticated mount above
// before requests ever reach here.
app.use(express.static(path.join(__dirname, "httpdocs")));

// Add better-sqlite3 import (optional - only if you want SQLite support)
let Database;
try {
  Database = require("better-sqlite3");
  console.log("✅ better-sqlite3 available for SQLite hillshades");
} catch (err) {
  console.log("⚠️ better-sqlite3 not installed - SQLite hillshades disabled");
  Database = null;
}

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(
  "/tiles/sqlite-hillshades",
  authenticateToken,
  express.static(path.join(__dirname, "cave-maps/sqlite-hillshades"))
);

// Load cave database for submission enhancement. Stored as plain JSON - no
// eval, no hand-rolled string escaping. The previous implementation stored
// this as a JS source file (`const caveDatabase = [...]`) and loaded it with
// `new Function(...)`, while writing values into it with naive string
// interpolation that never escaped quotes in cave names/notes. That combo
// meant a value containing a `"` could break out of its string literal and
// inject arbitrary JavaScript that would then be *executed* the next time the
// server read the file back in - a stored remote-code-execution bug. JSON has
// no such ambiguity, so we use it instead.
let caveDatabase = [];

function loadCaveDatabaseFromDisk() {
  try {
    if (!fs.existsSync(CAVE_DB_FILE)) return [];
    const raw = fs.readFileSync(CAVE_DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("❌ Failed to load cave database:", error);
    return [];
  }
}

function reloadCaveDatabase() {
  caveDatabase = loadCaveDatabaseFromDisk();
  console.log(`✅ Loaded ${caveDatabase.length} caves from database`);
  return caveDatabase;
}

reloadCaveDatabase();

// State/county reference data - see scripts/generate-states-config.js and
// STATES_CONFIG_FILE above. Loaded once at startup: this is static
// geographic reference data checked into git, not something that changes
// while the server is running, unlike the cave database. Every dropdown,
// filter, and cave-ID prefix in the app is ultimately driven from this.
let statesConfig = [];

function loadStatesConfig() {
  let raw;
  try {
    raw = fs.readFileSync(STATES_CONFIG_FILE, "utf8");
  } catch (err) {
    console.error(
      `FATAL: Could not read ${STATES_CONFIG_FILE}. This file is tracked in git and ` +
        "should always be present - run `node scripts/generate-states-config.js` to " +
        `(re)generate it. Underlying error: ${err.message}`
    );
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: ${STATES_CONFIG_FILE} is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(parsed.states) || parsed.states.length === 0) {
    console.error(`FATAL: ${STATES_CONFIG_FILE} has no states array.`);
    process.exit(1);
  }

  statesConfig = parsed.states;
  console.log(`✅ Loaded ${statesConfig.length} states from reference config`);
  return statesConfig;
}

loadStatesConfig();

// Public reference data (real, published county/state names - no cave data,
// nothing sensitive). Deliberately NOT behind authenticateToken: the
// create-account form needs this to populate its state picker, and that
// happens before anyone has a login token at all. This is no more exposed
// than before this feature existed, when Florida's county list sat in
// plain, unauthenticated static HTML.
app.get("/api/states", (req, res) => {
  res.json(statesConfig);
});

// Promise-returning version so callers that need to await the write (e.g.
// the submission-approval route, which writes the cave database and then
// the submissions file) can do so without nesting callbacks.
function persistCaveDatabase(caves) {
  backupDataFile(CAVE_DB_FILE);
  return fs.promises
    .writeFile(CAVE_DB_FILE, JSON.stringify(caves, null, 2), "utf8")
    .then(() => {
      reloadCaveDatabase();
    });
}

function writeCaveDatabase(caves, res, successPayload) {
  persistCaveDatabase(caves)
    .then(() => res.json(successPayload))
    .catch((err) => {
      console.error("Failed to write cave database:", err);
      res.status(500).json({ error: "Failed to save cave database." });
    });
}

// Applies proposedData from an approved submission onto the live cave
// database, normalizing lat/lng key aliases the way every other write path
// does. Returns the array of caves (mutated in place for new_cave) so the
// caller can persist it; throws with a { status, message } shape on
// validation failure so the route can turn it into the right HTTP response.
function applyApprovedSubmission(submission, caves) {
  if (submission.type === "new_cave") {
    const stateCode = submission.state || submission.proposedData?.state || DEFAULT_STATE_CODE;
    const countyCode = submission.county || submission.proposedData?.county;
    if (!countyCode) {
      throw { status: 400, message: "Submission is missing a county code; cannot assign a cave ID." };
    }
    const uniqueId = generateNextCaveId(stateCode, countyCode, caves);
    const newCave = { ...submission.proposedData, id: uniqueId, state: stateCode, county: countyCode };
    if (newCave.lat !== undefined) {
      newCave.latitude = newCave.lat;
    } else if (newCave.latitude !== undefined) {
      newCave.lat = newCave.latitude;
    }
    if (newCave.lng !== undefined) {
      newCave.longitude = newCave.lng;
    } else if (newCave.longitude !== undefined) {
      newCave.lng = newCave.longitude;
    }
    caves.push(newCave);
    submission.assignedCaveId = uniqueId;
  } else if (submission.type === "edit_cave") {
    const caveIndex = caves.findIndex((c) => c.id === submission.caveId);
    if (caveIndex === -1) {
      throw { status: 404, message: `Cave with ID ${submission.caveId} no longer exists.` };
    }
    const merged = { ...caves[caveIndex], ...submission.proposedData, id: caves[caveIndex].id };
    if (merged.lat !== undefined) {
      merged.latitude = merged.lat;
    } else if (merged.latitude !== undefined) {
      merged.lat = merged.latitude;
    }
    if (merged.lng !== undefined) {
      merged.longitude = merged.lng;
    } else if (merged.longitude !== undefined) {
      merged.lng = merged.longitude;
    }
    caves[caveIndex] = merged;
  } else {
    throw { status: 400, message: `Unknown submission type: ${submission.type}` };
  }
  return caves;
}

// Save route with enhanced functionality to handle single cave updates and
// new cave creation. Restricted to admin/webmaster - this writes the
// authoritative cave database.
app.post(
  "/api/save-cave-database",
  authenticateToken,
  requireRole("admin", "webmaster"),
  (req, res) => {
    const requestData = req.body;

    // Check if this is a single cave update request
    if (requestData.action === "updateSingle" && requestData.cave) {
      const updatedCave = requestData.cave;
      const caves = loadCaveDatabaseFromDisk();

      const caveIndex = caves.findIndex((c) => c.id === updatedCave.id);
      if (caveIndex === -1) {
        return res
          .status(404)
          .json({ error: `Cave with ID ${updatedCave.id} not found.` });
      }

      caves[caveIndex] = updatedCave;

      // Normalize coordinates for the updated cave
      if (caves[caveIndex].lat !== undefined) {
        caves[caveIndex].latitude = caves[caveIndex].lat;
      } else if (caves[caveIndex].latitude !== undefined) {
        caves[caveIndex].lat = caves[caveIndex].latitude;
      }

      if (caves[caveIndex].lng !== undefined) {
        caves[caveIndex].longitude = caves[caveIndex].lng;
      } else if (caves[caveIndex].longitude !== undefined) {
        caves[caveIndex].lng = caves[caveIndex].longitude;
      }

      console.log(`Updated cave ${updatedCave.id}`);
      writeCaveDatabase(caves, res, { message: "Cave updated successfully." });
    }

    // Check if this is a new cave creation request
    else if (requestData.action === "createNew" && requestData.cave) {
      const newCave = requestData.cave;
      const caves = loadCaveDatabaseFromDisk();

      // Generate a guaranteed unique ID on the server side
      const stateCode = newCave.state || DEFAULT_STATE_CODE;
      const countyCode = newCave.county || newCave.id?.substring(1, 3);
      if (!countyCode) {
        return res
          .status(400)
          .json({ error: "County code is required for new cave." });
      }

      const uniqueId = generateNextCaveId(stateCode, countyCode, caves);
      newCave.id = uniqueId; // Override any client-provided ID
      newCave.state = stateCode;
      newCave.county = countyCode;

      console.log(
        `Generated unique cave ID: ${uniqueId} for state ${stateCode}, county ${countyCode}`
      );

      // Ensure coordinates are normalized for the new cave
      if (newCave.lat !== undefined) {
        newCave.latitude = newCave.lat;
      } else if (newCave.latitude !== undefined) {
        newCave.lat = newCave.latitude;
      }

      if (newCave.lng !== undefined) {
        newCave.longitude = newCave.lng;
      } else if (newCave.longitude !== undefined) {
        newCave.lng = newCave.longitude;
      }

      caves.push(newCave);

      console.log(`Created new cave ${uniqueId}`);
      writeCaveDatabase(caves, res, {
        message: "New cave created successfully.",
        caveId: uniqueId,
      });
    } else {
      // Handle full database update (existing behavior)
      const caveData = requestData;

      if (!Array.isArray(caveData)) {
        return res.status(400).json({ error: "Invalid data format" });
      }

      // ── Normalize lat/lng keys on every cave ───────────────────────────
      caveData.forEach((cave) => {
        if (cave.lat !== undefined) {
          cave.latitude = cave.lat;
        }
        if (cave.lng !== undefined) {
          cave.longitude = cave.lng;
        }
      });

      writeCaveDatabase(caveData, res, {
        message: "Cave database saved successfully.",
      });
    }
  }
);

// Keep your existing update-cave-location endpoint
app.post(
  "/api/update-cave-location",
  authenticateToken,
  requireRole("admin", "webmaster"),
  (req, res) => {
    const { id, latitude, longitude } = req.body;
    if (!id || typeof latitude !== "number" || typeof longitude !== "number") {
      return res.status(400).json({ error: "Missing or invalid parameters" });
    }

    const caves = loadCaveDatabaseFromDisk();
    const cave = caves.find((c) => c.id === id);
    if (!cave) {
      return res.status(404).json({ error: `Cave with ID ${id} not found.` });
    }

    cave.latitude = latitude;
    cave.longitude = longitude;
    cave.lat = latitude;
    cave.lng = longitude;

    console.log(`Updated location for cave ${id}`);
    writeCaveDatabase(caves, res, {
      message: "Cave location updated successfully.",
    });
  }
);

// Column order/labels shared by the import template and the import parser -
// intentionally the same shape as the "Download Updated Cave Data" export in
// httpdocs/index.html's exportToExcel(), minus State (fixed by the ?state=
// import target, not per-row) and Cave ID (always server-generated, never
// trusted from the file). Each entry maps one spreadsheet column header to
// the cave record field it becomes.
const CAVE_IMPORT_COLUMNS = [
  { header: "County", field: "county" },
  { header: "Record Type", field: "recordType" },
  { header: "Entrance No", field: "entranceNumber" },
  { header: "Line No", field: "lineNumber" },
  { header: "Cave Name", field: "name" },
  { header: "Township", field: "township" },
  { header: "Range", field: "range" },
  { header: "Section", field: "section" },
  { header: "Section Part", field: "sectionPart" },
  { header: "Sub-Part", field: "subPart" },
  { header: "Location Accuracy", field: "locationAccuracy" },
  { header: "USGS Quad", field: "usgsQuad" },
  { header: "Topo Symbol", field: "topoSymbol" },
  { header: "Elevation", field: "elevation" },
  { header: "Ownership", field: "ownership" },
  { header: "Entry Status", field: "entryStatus" },
  { header: "Equipment Needed", field: "equipment" },
  { header: "Entrance Type", field: "entranceType" },
  { header: "Field Indication", field: "fieldIndication" },
  { header: "Location Info Type", field: "locationInfo" },
  { header: "Map Type", field: "mapType" },
  { header: "Map Status", field: "mapStatus" },
  { header: "Geologic Formation", field: "geology" },
  { header: "Topographic Province", field: "topoProvince" },
  { header: "Cave Length", field: "length" },
  { header: "Vertical Extent", field: "vertical" },
  { header: "Max Water Depth", field: "waterDepth" },
  { header: "Deepest Pitch", field: "pitch" },
  { header: "Latitude", field: "latitude" },
  { header: "Longitude", field: "longitude" },
  { header: "Exploration Possibility", field: "exploration" },
  { header: "Reporter NSS #", field: "reporter" },
  { header: "Date YYMM", field: "date" },
  { header: "Cave Type", field: "type" },
  { header: "Hazardous Conditions", field: "hazardConditions" },
  { header: "Hazard Notes", field: "hazardNotes" },
  { header: "Owner/Entity Info", field: "ownerInfo" },
];

// Downloadable .xlsx template for a state's Excel import: a header row plus
// one example row using that state's own first county, so whoever fills it
// in sees a real, valid county code rather than having to guess the format.
// Admin/webmaster only, matching every other cave-data-authoring route.
app.get(
  "/api/cave-database/import-template",
  authenticateToken,
  requireRole("admin", "webmaster"),
  (req, res) => {
    const stateCode = req.query.state;
    const state = statesConfig.find((s) => s.code === stateCode);
    if (!state) {
      return res.status(400).json({ error: "Unknown or missing state code." });
    }

    const headerRow = CAVE_IMPORT_COLUMNS.map((c) => c.header);
    const exampleCounty = state.counties[0];
    const exampleRow = CAVE_IMPORT_COLUMNS.map((c) => {
      if (c.field === "county") return exampleCounty ? exampleCounty.code : "";
      if (c.field === "name") return "Example Cave Name";
      if (c.field === "latitude") return 29.6;
      if (c.field === "longitude") return -82.3;
      return "";
    });

    const ws = XLSX.utils.aoa_to_sheet([headerRow, exampleRow]);
    ws["!cols"] = headerRow.map((h) => ({ wch: Math.max(h.length, 18) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Import Template");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${stateCode}_cave_import_template.xlsx"`
    );
    res.send(buffer);
  }
);

// Memory storage (never touches disk) for the import upload - the file is
// parsed once, immediately, and discarded; nothing about it needs to
// persist the way cave maps/pictures do.
const caveImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".xlsx", ".xls", ".csv"].includes(ext)) {
      return cb(new Error(`Unsupported file type: ${ext || "(no extension)"}`));
    }
    cb(null, true);
  },
});

// Bulk-imports a spreadsheet of caves into one target state. Admin/webmaster
// only - this writes the authoritative cave database, same restriction as
// /api/save-cave-database. Every row is validated independently and the
// response reports success/failure per row (not all-or-nothing): one bad
// row in an otherwise-good 200-row spreadsheet shouldn't block the other
// 199, and the per-row report tells the importer exactly what to fix.
app.post(
  "/api/cave-database/import",
  authenticateToken,
  requireRole("admin", "webmaster"),
  (req, res) => {
    caveImportUpload.single("importFile")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "Upload failed" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      const stateCode = req.body.state;
      const state = statesConfig.find((s) => s.code === stateCode);
      if (!state) {
        return res.status(400).json({ error: "Unknown or missing state code." });
      }
      const validCountyCodes = new Set(state.counties.map((c) => c.code));

      let rows;
      try {
        const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      } catch (parseErr) {
        return res.status(400).json({ error: "Could not parse the uploaded file. Is it a valid spreadsheet?" });
      }

      if (rows.length === 0) {
        return res.status(400).json({ error: "The uploaded file has no data rows." });
      }

      const caves = loadCaveDatabaseFromDisk();
      const report = [];
      let importedCount = 0;

      rows.forEach((row, i) => {
        const spreadsheetRow = i + 2; // 1-based, plus the header row
        const name = String(row["Cave Name"] || "").trim();
        const countyCode = String(row["County"] || "").trim().toUpperCase();
        const latitude = parseFloat(row["Latitude"]);
        const longitude = parseFloat(row["Longitude"]);

        if (!name) {
          report.push({ row: spreadsheetRow, status: "error", reason: "Missing Cave Name." });
          return;
        }
        if (!countyCode) {
          report.push({ row: spreadsheetRow, status: "error", reason: "Missing County.", name });
          return;
        }
        if (!validCountyCodes.has(countyCode)) {
          report.push({
            row: spreadsheetRow,
            status: "error",
            reason: `"${countyCode}" is not a valid county code for ${state.name}.`,
            name,
          });
          return;
        }
        if (isNaN(latitude) || isNaN(longitude)) {
          report.push({ row: spreadsheetRow, status: "error", reason: "Missing or invalid Latitude/Longitude.", name });
          return;
        }

        const newCave = { name, state: stateCode, county: countyCode, latitude, longitude, lat: latitude, lng: longitude };
        CAVE_IMPORT_COLUMNS.forEach(({ header, field }) => {
          if (["name", "county", "latitude", "longitude"].includes(field)) return;
          const value = row[header];
          if (value !== "" && value !== undefined && value !== null) {
            newCave[field] = value;
          }
        });

        // Generated against `caves`, which already includes every row
        // imported earlier in this same batch, so IDs within one
        // state+county still increment correctly across the whole file.
        const caveId = generateNextCaveId(stateCode, countyCode, caves);
        newCave.id = caveId;
        caves.push(newCave);
        importedCount++;
        report.push({ row: spreadsheetRow, status: "success", caveId, name });
      });

      if (importedCount === 0) {
        return res.json({
          message: "No rows were imported - every row had an error.",
          imported: 0,
          total: rows.length,
          report,
        });
      }

      persistCaveDatabase(caves)
        .then(() => {
          console.log(`Imported ${importedCount}/${rows.length} caves for ${stateCode} from spreadsheet upload`);
          res.json({
            message: `Imported ${importedCount} of ${rows.length} row(s).`,
            imported: importedCount,
            total: rows.length,
            report,
          });
        })
        .catch((writeErr) => {
          console.error("Failed to write cave database during import:", writeErr);
          res.status(500).json({ error: "Failed to save imported caves." });
        });
    });
  }
);

// On startup, ensure the file exists
if (!fs.existsSync(submissionsFile)) {
  fs.writeFileSync(submissionsFile, "[]", "utf8");
}

// Fetch all pending submissions (enhanced with cave data)
app.get("/api/pending-submissions", authenticateToken, (req, res) => {
  console.log("→ [SERVER] GET /api/pending-submissions");

  fs.readFile(submissionsFile, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read pending submissions:", err);
      return res.status(500).json({ error: "Could not load submissions." });
    }
    try {
      const submissions = JSON.parse(data);

      // Enhance submissions with cave data
      const enhancedSubmissions = submissions.map((submission) => {
        if (submission.caveId) {
          // Look up cave data from database
          const caveData = caveDatabase.find(
            (cave) => cave.id === submission.caveId
          );

          if (caveData) {
            console.log(
              `Enhancing submission for cave ${submission.caveId}: ${caveData.name}`
            );
            const resolved = resolveCaveStateAndCounty(caveData);

            // Add missing cave information
            if (!submission.caveName) {
              submission.caveName = caveData.name;
            }

            if (!submission.caveType) {
              submission.caveType = caveData.type;
            }

            if (!submission.county) {
              submission.county = resolved.county;
            }

            if (!submission.state) {
              submission.state = resolved.state;
            }

            // For move submissions, ensure we have original coordinates
            if (
              (submission.type === "move" ||
                submission.type === "move_cave" ||
                submission.type === "move_location") &&
              !submission.originalCoordinates &&
              (caveData.latitude || caveData.lat)
            ) {
              submission.originalCoordinates = {
                lat: caveData.latitude || caveData.lat,
                lng: caveData.longitude || caveData.lng,
              };
              console.log(
                `Added original coordinates for ${submission.caveId}`
              );
            }

            // For edit submissions, add current cave data for comparison
            if (
              (submission.type === "edit" || submission.type === "edit_cave") &&
              !submission.currentCaveData
            ) {
              submission.currentCaveData = {
                id: caveData.id,
                name: caveData.name,
                state: resolved.state,
                county: resolved.county,
                type: caveData.type,
                latitude: caveData.latitude || caveData.lat,
                longitude: caveData.longitude || caveData.lng,
                elevation: caveData.elevation,
                entranceType: caveData.entranceType,
                fieldIndication: caveData.fieldIndication,
                entryStatus: caveData.entryStatus,
                ownerInfo: caveData.ownerInfo,
                equipment: caveData.equipment,
                length: caveData.length,
                vertical: caveData.vertical,
                waterDepth: caveData.waterDepth,
                mapType: caveData.mapType,
                mapStatus: caveData.mapStatus,
                geology: caveData.geology,
                topoProvince: caveData.topoProvince,
                pitch: caveData.pitch,
                notes: caveData.notes,
                reporterName: caveData.reporterName,
                reporterNSS: caveData.reporterNSS,
                hazards: caveData.hazards,
                entrances: caveData.entrances,
                exploration: caveData.exploration,
                locationAccuracy: caveData.locationAccuracy,
              };
              console.log(`Added current cave data for ${submission.caveId}`);
            }
          } else {
            console.log(`Cave ${submission.caveId} not found in database`);
          }
        }

        // Ensure status is set
        if (!submission.status) {
          submission.status = "pending";
        }

        // Normalize submitter information
        if (submission.submittedBy && !submission.submitter) {
          submission.submitter = {
            name: submission.submittedBy,
            date: submission.submittedAt,
          };
        }

        return submission;
      });

      console.log(
        `Enhanced ${enhancedSubmissions.length} submissions with cave data`
      );

      const users = loadUsers();
      const requestingUser = users.find((u) => u.username === req.user.username);
      const allowed = getAllowedStatesForUser(requestingUser);
      const visibleSubmissions =
        allowed === null ? enhancedSubmissions : enhancedSubmissions.filter((s) => allowed.includes(s.state));

      res.json(visibleSubmissions);
    } catch (parseErr) {
      console.error("Corrupt submissions file:", parseErr);
      res.status(500).json({ error: "Submissions file is invalid." });
    }
  });
});

// Fetch all approved submissions
app.get("/api/approved-submissions", authenticateToken, (req, res) => {
  console.log("→ [SERVER] GET /api/approved-submissions");

  fs.readFile(submissionsFile, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read approved submissions:", err);
      return res.status(500).json({ error: "Could not load submissions." });
    }
    try {
      const submissions = JSON.parse(data);

      // Filter for approved submissions only
      const approvedSubmissions = submissions.filter(
        (submission) => submission.status === "approved"
      );

      // Enhance approved submissions with cave data (same as pending)
      const enhancedSubmissions = approvedSubmissions.map((submission) => {
        if (submission.caveId) {
          // Look up cave data from database
          const caveData = caveDatabase.find(
            (cave) => cave.id === submission.caveId
          );

          if (caveData) {
            console.log(
              `Enhancing approved submission for cave ${submission.caveId}: ${caveData.name}`
            );
            const resolved = resolveCaveStateAndCounty(caveData);

            // Add missing cave information
            if (!submission.caveName) {
              submission.caveName = caveData.name;
            }

            if (!submission.caveType) {
              submission.caveType = caveData.type;
            }

            if (!submission.county) {
              submission.county = resolved.county;
            }

            if (!submission.state) {
              submission.state = resolved.state;
            }

            // For move submissions, ensure we have original coordinates
            if (
              (submission.type === "move" ||
                submission.type === "move_cave" ||
                submission.type === "move_location") &&
              !submission.originalCoordinates &&
              (caveData.latitude || caveData.lat)
            ) {
              submission.originalCoordinates = {
                lat: caveData.latitude || caveData.lat,
                lng: caveData.longitude || caveData.lng,
              };
            }

            // For edit submissions, add current cave data for comparison
            if (
              (submission.type === "edit" || submission.type === "edit_cave") &&
              !submission.currentCaveData
            ) {
              submission.currentCaveData = {
                id: caveData.id,
                name: caveData.name,
                state: resolved.state,
                county: resolved.county,
                type: caveData.type,
                latitude: caveData.latitude || caveData.lat,
                longitude: caveData.longitude || caveData.lng,
                elevation: caveData.elevation,
                entranceType: caveData.entranceType,
                fieldIndication: caveData.fieldIndication,
                entryStatus: caveData.entryStatus,
                ownerInfo: caveData.ownerInfo,
                equipment: caveData.equipment,
                length: caveData.length,
                vertical: caveData.vertical,
                waterDepth: caveData.waterDepth,
                mapType: caveData.mapType,
                mapStatus: caveData.mapStatus,
                geology: caveData.geology,
                topoProvince: caveData.topoProvince,
                pitch: caveData.pitch,
                notes: caveData.notes,
                reporterName: caveData.reporterName,
                reporterNSS: caveData.reporterNSS,
                hazards: caveData.hazards,
                entrances: caveData.entrances,
                exploration: caveData.exploration,
                locationAccuracy: caveData.locationAccuracy,
              };
            }
          } else {
            console.log(`Cave ${submission.caveId} not found in database`);
          }
        }

        // Normalize submitter information
        if (submission.submittedBy && !submission.submitter) {
          submission.submitter = {
            name: submission.submittedBy,
            date: submission.submittedAt,
          };
        }

        return submission;
      });

      console.log(`Found ${enhancedSubmissions.length} approved submissions`);

      const users = loadUsers();
      const requestingUser = users.find((u) => u.username === req.user.username);
      const allowed = getAllowedStatesForUser(requestingUser);
      const visibleSubmissions =
        allowed === null ? enhancedSubmissions : enhancedSubmissions.filter((s) => allowed.includes(s.state));

      res.json(visibleSubmissions);
    } catch (parseErr) {
      console.error("Corrupt submissions file:", parseErr);
      res.status(500).json({ error: "Submissions file is invalid." });
    }
  });
});

// Add a new pending submission. Any logged-in member can propose a new cave
// or an edit to an existing one; identity and timestamp are always derived
// from the authenticated session, never trusted from the request body, so a
// member can't submit a proposal under someone else's name.
app.post("/api/pending-submissions", authenticateToken, (req, res) => {
  const { type, caveId, caveName, state, county, proposedData } = req.body || {};

  if (!type || !["new_cave", "edit_cave"].includes(type)) {
    return res
      .status(400)
      .json({ error: "type must be 'new_cave' or 'edit_cave'." });
  }
  if (!caveId) {
    return res.status(400).json({ error: "Missing required field: caveId" });
  }
  if (!proposedData || typeof proposedData !== "object") {
    return res
      .status(400)
      .json({ error: "Missing required field: proposedData" });
  }
  if (type === "edit_cave" && !caveDatabase.some((cave) => cave.id === caveId)) {
    return res.status(404).json({ error: `Cave with ID ${caveId} not found.` });
  }

  // Same transitional default as cave creation (see DEFAULT_STATE_CODE) -
  // the client doesn't send `state` yet, so treat its absence as Florida
  // rather than rejecting every submission until the frontend catches up.
  const submissionState = state || proposedData.state || DEFAULT_STATE_CODE;

  const submittingUser = loadUsers().find((u) => u.username === req.user.username);
  const allowedStates = getAllowedStatesForUser(submittingUser);
  if (allowedStates !== null && !allowedStates.includes(submissionState)) {
    return res.status(403).json({ error: `You do not have access to submit for ${submissionState}.` });
  }

  const submission = {
    submissionId: crypto.randomUUID(),
    type,
    caveId,
    caveName: caveName || proposedData.name || "",
    state: submissionState,
    county: county || proposedData.county || "",
    proposedData,
    submittedBy: req.user.username,
    submittedAt: new Date().toISOString(),
    status: "pending",
  };

  console.log(
    "Received submission:",
    submission.type,
    "for cave:",
    submission.caveId,
    "from",
    submission.submittedBy
  );

  fs.readFile(submissionsFile, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read submissions:", err);
      return res.status(500).json({ error: "Could not load submissions." });
    }

    let submissions;
    try {
      submissions = JSON.parse(data);
    } catch {
      submissions = [];
    }

    submissions.push(submission);

    fs.writeFile(
      submissionsFile,
      JSON.stringify(submissions, null, 2),
      "utf8",
      (err) => {
        if (err) {
          console.error("Failed to save submission:", err);
          return res.status(500).json({ error: "Could not save submission." });
        }
        console.log("Submission saved successfully");
        res.json({ message: "Submission received.", submission });
      }
    );
  });
});

// Update submission status (approve/reject). Approving a submission is the
// only place that ever writes a member's proposed change into the real cave
// database - it applies proposedData here, not at submission time. approvedBy
// / rejectedBy always come from the authenticated session, never the request
// body, so a reviewer can't attribute the decision to someone else.
app.patch(
  "/api/pending-submissions/:id",
  authenticateToken,
  requireRole("admin", "webmaster"),
  async (req, res) => {
    const submissionId = req.params.id;
    const { status, rejectionReason } = req.body;

    if (!status || !["approved", "rejected"].includes(status)) {
      return res
        .status(400)
        .json({ error: "Invalid status. Must be 'approved' or 'rejected'" });
    }

    let submissions;
    try {
      const data = await fs.promises.readFile(submissionsFile, "utf8");
      submissions = JSON.parse(data);
    } catch (err) {
      console.error("Failed to read submissions:", err);
      return res.status(500).json({ error: "Could not load submissions." });
    }

    const submissionIndex = submissions.findIndex(
      (sub) => sub.submissionId === submissionId || sub.caveId === submissionId
    );
    if (submissionIndex === -1) {
      return res.status(404).json({ error: "Submission not found" });
    }

    const submission = submissions[submissionIndex];
    if (submission.status !== "pending") {
      return res
        .status(409)
        .json({ error: `Submission has already been ${submission.status}.` });
    }

    if (status === "approved") {
      const caves = loadCaveDatabaseFromDisk();
      try {
        applyApprovedSubmission(submission, caves);
      } catch (err) {
        if (err && err.status) {
          return res.status(err.status).json({ error: err.message });
        }
        console.error("Failed to apply approved submission:", err);
        return res.status(500).json({ error: "Failed to apply submission to cave database." });
      }

      try {
        await persistCaveDatabase(caves);
      } catch (err) {
        console.error("Failed to write cave database:", err);
        return res.status(500).json({ error: "Failed to save cave database." });
      }

      submission.status = "approved";
      submission.approvedBy = req.user.username;
      submission.approvedDate = new Date().toISOString();
    } else {
      submission.status = "rejected";
      submission.rejectedBy = req.user.username;
      submission.rejectedDate = new Date().toISOString();
      if (rejectionReason) {
        submission.rejectionReason = rejectionReason;
      }
    }

    try {
      await fs.promises.writeFile(
        submissionsFile,
        JSON.stringify(submissions, null, 2),
        "utf8"
      );
    } catch (err) {
      console.error("Failed to save submissions:", err);
      return res.status(500).json({ error: "Could not save submissions." });
    }

    console.log(`Updated submission ${submissionId} status to ${submission.status}`);
    res.json({
      message: `Submission ${submission.status} successfully`,
      submission,
    });
  }
);

// Remove/update pending submissions
app.delete(
  "/api/pending-submissions/:id",
  authenticateToken,
  requireRole("admin", "webmaster"),
  (req, res) => {
  const submissionId = req.params.id;

  fs.readFile(submissionsFile, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read submissions:", err);
      return res.status(500).json({ error: "Could not load submissions." });
    }

    let submissions;
    try {
      submissions = JSON.parse(data);
    } catch {
      submissions = [];
    }

    // Filter out the submission to remove
    const originalLength = submissions.length;
    submissions = submissions.filter(
      (sub) => sub.submissionId !== submissionId && sub.caveId !== submissionId
    );

    if (submissions.length === originalLength) {
      return res.status(404).json({ error: "Submission not found" });
    }

    fs.writeFile(
      submissionsFile,
      JSON.stringify(submissions, null, 2),
      "utf8",
      (err) => {
        if (err) {
          console.error("Failed to save submissions:", err);
          return res.status(500).json({ error: "Could not save submissions." });
        }
        console.log(`Removed submission ${submissionId}`);
        res.json({ message: "Submission removed successfully" });
      }
    );
  });
});

// Cave Maps API Endpoints
// Overridable so the test suite can point this at a throwaway directory.
const caveMapsDir = process.env.CAVE_MAPS_DIR
  ? path.resolve(process.env.CAVE_MAPS_DIR)
  : path.join(__dirname, "cave-maps");

// Ensure cave-maps overlay directories exist
const geotiffDir = path.join(caveMapsDir, "geotiff");
const shapefilesDir = path.join(caveMapsDir, "shapefiles");

if (!fs.existsSync(caveMapsDir)) {
  fs.mkdirSync(caveMapsDir);
}
if (!fs.existsSync(geotiffDir)) {
  fs.mkdirSync(geotiffDir);
}
if (!fs.existsSync(shapefilesDir)) {
  fs.mkdirSync(shapefilesDir);
}

// Ensure cave map directories exist
const caveMapsCollectionDir = path.join(__dirname, "cave-maps", "cavemaps");

// Ensure cavemaps directory exists
if (!fs.existsSync(caveMapsCollectionDir)) {
  fs.mkdirSync(caveMapsCollectionDir, { recursive: true });
}

// ADD THIS: Define the SQLite hillshades directory
const sqliteHillshadesDir = path.join(
  __dirname,
  "cave-maps",
  "sqlite-hillshades"
);

// Ensure SQLite hillshades directory exists
if (!fs.existsSync(sqliteHillshadesDir)) {
  fs.mkdirSync(sqliteHillshadesDir, { recursive: true });
  console.log("✅ Created SQLite hillshades directory");
}

// API endpoint to list available cave maps
app.get("/api/cave-maps/list", authenticateToken, (req, res) => {
  console.log("→ [SERVER] GET /api/cave-maps/list");

  const maps = [];

  try {
    // Scan geotiff folder
    if (fs.existsSync(geotiffDir)) {
      const geotiffFiles = fs
        .readdirSync(geotiffDir)
        .filter(
          (file) =>
            file.toLowerCase().endsWith(".tif") ||
            file.toLowerCase().endsWith(".tiff")
        );

      geotiffFiles.forEach((file) => {
        const filePath = path.join(geotiffDir, file);
        const stats = fs.statSync(filePath);

        maps.push({
          id: `geotiff_${file}`,
          name: file.replace(/\.(tif|tiff)$/i, ""),
          type: "geotiff",
          url: `/cave-maps/geotiff/${file}`,
          size: stats.size,
          dateAdded: stats.birthtime,
        });
      });
    }

    // Scan shapefile folder
    if (fs.existsSync(shapefilesDir)) {
      const files = fs.readdirSync(shapefilesDir);

      const shapefileMap = new Map();

      files.forEach((file) => {
        const ext = path.extname(file).toLowerCase();
        const baseName = file.replace(/\.(shp|zip)$/i, "");

        if (ext === ".zip") {
          // Prefer zipped shapefile if present
          const filePath = path.join(shapefilesDir, file);
          const stats = fs.statSync(filePath);
          shapefileMap.set(baseName, {
            id: `shapefile_${baseName}`,
            name: baseName,
            type: "shapefile",
            url: `/cave-maps/shapefiles/${file}`,
            baseUrl: `/cave-maps/shapefiles/${baseName}`,
            size: stats.size,
            dateAdded: stats.birthtime,
          });
        } else if (ext === ".shp" && !shapefileMap.has(baseName)) {
          // Only include .shp if .zip doesn't exist
          const requiredFiles = [".shx", ".dbf"];
          const hasAll = requiredFiles.every((ext) =>
            fs.existsSync(path.join(shapefilesDir, `${baseName}${ext}`))
          );

          if (hasAll) {
            const filePath = path.join(shapefilesDir, file);
            const stats = fs.statSync(filePath);
            shapefileMap.set(baseName, {
              id: `shapefile_${baseName}`,
              name: baseName,
              type: "shapefile",
              url: `/cave-maps/shapefiles/${file}`,
              baseUrl: `/cave-maps/shapefiles/${baseName}`,
              size: stats.size,
              dateAdded: stats.birthtime,
            });
          } else {
            console.warn(`Incomplete shapefile: ${baseName}`);
          }
        }
      });

      maps.push(...Array.from(shapefileMap.values()));
    }

    console.log(`Found ${maps.length} cave maps`);
    res.json(maps);
  } catch (error) {
    console.error("Error scanning cave maps:", error);
    res.status(500).json({ error: "Failed to scan cave maps directory" });
  }
});

// Endpoint to help debug shapefile loading issues. This used to be defined
// *inside* the /api/cave-maps/list handler above, which meant Express got a
// brand new duplicate route handler registered on every single call to
// /api/cave-maps/list - an unbounded memory/handler leak. Hoisted out here so
// it's only registered once, at startup.
app.get("/api/cave-maps/validate/:type/:filename", authenticateToken, (req, res) => {
  const { type } = req.params;
  // path.basename strips any directory components (e.g. "../../etc/passwd"),
  // so this can never escape the shapefiles directory.
  const filename = path.basename(req.params.filename);

  if (type !== "shapefile") {
    return res
      .status(400)
      .json({ error: "Only shapefile validation supported" });
  }

  try {
    const baseName = filename.replace(/\.(shp|zip)$/i, "");

    // Check for zip file first, regardless of input filename
    const zipPath = path.join(shapefilesDir, `${baseName}.zip`);

    if (fs.existsSync(zipPath)) {
      return res.json({
        filename: baseName,
        isValid: true,
        isZip: true,
        files: {
          zip: { exists: true, size: fs.statSync(zipPath).size },
        },
        urls: {
          zip: `/cave-maps/shapefiles/${baseName}.zip`,
        },
      });
    }

    // Else fallback to component check
    const files = {
      shp: path.join(shapefilesDir, `${baseName}.shp`),
      shx: path.join(shapefilesDir, `${baseName}.shx`),
      dbf: path.join(shapefilesDir, `${baseName}.dbf`),
      prj: path.join(shapefilesDir, `${baseName}.prj`),
    };

    const status = {};

    for (const [ext, filePath] of Object.entries(files)) {
      status[ext] = {
        exists: fs.existsSync(filePath),
        size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
      };
    }

    const isValid =
      status.shp.exists && status.shx.exists && status.dbf.exists;

    res.json({
      filename: baseName,
      isValid,
      isZip: false,
      files: status,
      urls: {
        shp: status.shp.exists ? `/cave-maps/shapefiles/${baseName}.shp` : null,
        shx: status.shx.exists ? `/cave-maps/shapefiles/${baseName}.shx` : null,
        dbf: status.dbf.exists ? `/cave-maps/shapefiles/${baseName}.dbf` : null,
        prj: status.prj.exists ? `/cave-maps/shapefiles/${baseName}.prj` : null,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to list cave maps collection
// API endpoint to list cave maps collection (from cavemaps folder)
app.get("/api/cave-maps-collection/list", authenticateToken, (req, res) => {
  console.log("→ [SERVER] GET /api/cave-maps-collection/list");

  const maps = [];

  try {
    // Scan cavemaps folder for image files
    if (fs.existsSync(caveMapsCollectionDir)) {
      const imageFiles = fs
        .readdirSync(caveMapsCollectionDir)
        .filter((file) => {
          const ext = file.toLowerCase();
          return (
            ext.endsWith(".jpg") ||
            ext.endsWith(".jpeg") ||
            ext.endsWith(".png") ||
            ext.endsWith(".gif") ||
            ext.endsWith(".bmp") ||
            ext.endsWith(".tif") ||
            ext.endsWith(".tiff") ||
            ext.endsWith(".pdf")
          );
        });

      imageFiles.forEach((file) => {
        const filePath = path.join(caveMapsCollectionDir, file);
        const stats = fs.statSync(filePath);

        maps.push({
          filename: file,
          name: file.replace(/\.[^/.]+$/, ""), // Remove extension
          url: `/cave-maps/cavemaps/${file}`,
          size: stats.size,
          dateAdded: stats.birthtime,
        });
      });
    }

    console.log(
      `Found ${maps.length} cave maps in collection from cavemaps folder`
    );
    res.json(maps);
  } catch (error) {
    console.error("Error scanning cave maps collection:", error);
    res
      .status(500)
      .json({ error: "Failed to scan cave maps collection directory" });
  }
});

// API endpoint to download cave map from collection
app.get(
  "/api/cave-maps-collection/download/:filename",
  authenticateToken,
  (req, res) => {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(caveMapsCollectionDir, filename);

    if (fs.existsSync(filePath)) {
      res.download(filePath);
    } else {
      res.status(404).json({ error: "Cave map file not found" });
    }
  }
);

// Serve cave maps collection files. These are cave location maps and are
// exactly the kind of data this app must keep away from anyone who isn't
// logged in - so this, like every other cave-maps route, requires a token.
app.use("/cave-maps-collection", authenticateToken, express.static(caveMapsCollectionDir));

// Upload endpoint for cave maps. This used to be a stub that always
// returned 501, while the client had a matching "Upload Maps" button and
// file input wired to a function that didn't even exist - so the whole
// upload feature was non-functional on both ends. Both sides are now wired
// up: GeoTIFFs go to geotiffDir, shapefile components (.shp/.shx/.dbf/...)
// go to shapefilesDir, matched by extension.
const CAVE_MAP_EXTENSIONS = new Set([
  ".tif",
  ".tiff",
  ".shp",
  ".shx",
  ".dbf",
  ".prj",
  ".cpg",
  ".sbn",
  ".sbx",
  ".zip",
]);

const caveMapUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === ".tif" || ext === ".tiff") {
        cb(null, geotiffDir);
      } else {
        cb(null, shapefilesDir);
      }
    },
    filename: (req, file, cb) => {
      // Unlike narrative image uploads, we can't fully randomize this name:
      // a shapefile is only recognized as complete when its .shp/.shx/.dbf/
      // .prj components share an identical base filename (see
      // /api/cave-maps/list above). So the original name is kept, just
      // stripped of anything that isn't a safe filename character.
      const base = path.basename(file.originalname).replace(/[^A-Za-z0-9._-]/g, "_");
      cb(null, base);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 20 }, // GeoTIFFs can be large
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!CAVE_MAP_EXTENSIONS.has(ext)) {
      return cb(new Error(`Unsupported file type: ${ext || "(no extension)"}`));
    }
    cb(null, true);
  },
});

app.post(
  "/api/cave-maps/upload",
  authenticateToken,
  requireRole("admin", "webmaster"),
  (req, res) => {
    caveMapUpload.array("mapFiles", 20)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "Upload failed" });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }
      console.log(`Uploaded ${req.files.length} cave map file(s)`);
      res.json({
        message: `Uploaded ${req.files.length} file(s) successfully.`,
        files: req.files.map((f) => f.filename),
      });
    });
  }
);

// Optional: Delete cave map endpoint
app.delete(
  "/api/cave-maps/:type/:filename",
  authenticateToken,
  requireRole("admin", "webmaster"),
  (req, res) => {
    const { type } = req.params;
    const filename = path.basename(req.params.filename);

    if (!["geotiff", "shapefiles"].includes(type)) {
      return res.status(400).json({ error: "Invalid map type" });
    }

    try {
      const targetDir = type === "geotiff" ? geotiffDir : shapefilesDir;

      if (type === "geotiff") {
        const filePath = path.join(targetDir, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`Deleted GeoTIFF: ${filename}`);
          res.json({ message: "Map deleted successfully" });
        } else {
          res.status(404).json({ error: "Map file not found" });
        }
      } else {
        // For shapefiles, delete all related files
        const extensions = [".shp", ".shx", ".dbf", ".prj", ".cpg", ".sbn", ".sbx"];
        let deletedFiles = 0;

        extensions.forEach((ext) => {
          const filePath = path.join(targetDir, filename + ext);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            deletedFiles++;
          }
        });

        if (deletedFiles > 0) {
          console.log(`Deleted shapefile: ${filename} (${deletedFiles} files)`);
          res.json({ message: "Shapefile deleted successfully" });
        } else {
          res.status(404).json({ error: "Shapefile not found" });
        }
      }
    } catch (error) {
      console.error("Error deleting cave map:", error);
      res.status(500).json({ error: "Failed to delete map" });
    }
  }
);

// Serve cave map files (GeoTIFFs, shapefiles, hillshades) statically. Auth
// required - see comment on /cave-maps-collection above. (The permissive
// wildcard CORS header that used to sit in front of this - allowing any
// website on the internet to read these files from a logged-in member's
// browser - has been removed; the app-wide CORS policy above already covers
// the legitimate front-end origin.)
app.use("/cave-maps", authenticateToken, express.static(caveMapsDir));

// Overridable so the test suite can point this at a throwaway directory
// instead of the real narratives/ folder.
const NARRATIVE_DIR = process.env.NARRATIVE_DIR
  ? path.resolve(process.env.NARRATIVE_DIR)
  : path.join(__dirname, "narratives");
if (!fs.existsSync(NARRATIVE_DIR)) fs.mkdirSync(NARRATIVE_DIR, { recursive: true });

// Save narrative
// Rich-text editor content allowed when saving a narrative. Deliberately
// leaves out <script>, event handler attributes (onerror=, onclick=, ...),
// javascript: URLs, etc. - anything not on this list is stripped rather than
// stored, which is what stops a malicious narrative from becoming a stored
// XSS payload served back to every member who later views it.
const NARRATIVE_SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "img",
    "u",
    "span",
    "font",
    "ins",
    "video",
  ]),
  allowedAttributes: {
    "*": ["style", "class"],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    font: ["color", "size", "face"],
  },
  allowedSchemes: ["http", "https", "data", "mailto"],
  allowVulnerableTags: false,
};

// Cave narrative IDs are cave record IDs (e.g. "F01001"); this is also used
// directly to build a filename on disk, so it's restricted to a safe
// charset - otherwise a value like "../../../../etc/cron.d/x" could write
// outside the narratives directory entirely.
function isSafeRecordId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

app.post("/save-narrative", authenticateToken, express.json(), (req, res) => {
  const { id, name, images, isEditing, originalTimestamp } = req.body;
  // The author is always the authenticated user, never a client-supplied
  // value - otherwise anyone could save a narrative "as" another member.
  const user = req.user.username;

  if (!id || !req.body.html) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!isSafeRecordId(id)) {
    return res.status(400).json({ error: "Invalid cave id" });
  }

  const html = sanitizeHtml(req.body.html, NARRATIVE_SANITIZE_OPTIONS);

  const filePath = path.join(NARRATIVE_DIR, `${id}.json`);

  // Read existing narratives for this cave
  let existingNarratives = [];
  if (fs.existsSync(filePath)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(filePath, "utf8"));
      // Handle both old single narrative format and new array format
      if (Array.isArray(fileData)) {
        existingNarratives = fileData;
      } else if (fileData.user) {
        // Convert old single narrative to array format
        existingNarratives = [fileData];
      }
    } catch (e) {
      console.log("Could not read existing narratives, starting fresh");
    }
  }

  const timestamp = new Date().toISOString();

  if (isEditing && originalTimestamp) {
    // Find and update existing narrative
    const narrativeIndex = existingNarratives.findIndex(
      (n) => n.user === user && n.timestamp === originalTimestamp
    );

    if (narrativeIndex !== -1) {
      existingNarratives[narrativeIndex] = {
        id,
        name,
        html,
        user,
        images: images || [],
        timestamp: existingNarratives[narrativeIndex].timestamp, // Keep original timestamp
        lastModified: timestamp,
      };
    }
  } else {
    // Add new narrative
    const newNarrative = {
      id,
      name,
      html,
      user,
      images: images || [],
      timestamp: timestamp,
    };
    existingNarratives.push(newNarrative);
  }

  fs.writeFile(filePath, JSON.stringify(existingNarratives, null, 2), (err) => {
    if (err) {
      console.error("Error saving narrative:", err);
      return res.status(500).json({ error: "Failed to save narrative" });
    }

    console.log(`Narrative saved for cave ${id} by ${user}`);
    res.json({ success: true, message: "Narrative saved successfully" });
  });
});

// Delete a specific narrative
app.delete("/delete-narrative", authenticateToken, express.json(), (req, res) => {
  const { caveId, timestamp, logDeletion } = req.body;
  // Who is allowed to delete is decided from the verified token, never from
  // a client-supplied "user" field - otherwise anyone could delete anyone
  // else's narrative just by naming them in the request body.
  const user = req.user.username;
  const isModerator = ["admin", "webmaster"].includes(req.user.role);

  console.log(
    `[DELETE] Attempting to delete narrative for cave ${caveId}, timestamp: ${timestamp}, user: ${user}`
  );

  if (!caveId || !timestamp) {
    return res
      .status(400)
      .json({ error: "Missing required fields: caveId, timestamp" });
  }
  if (!isSafeRecordId(caveId)) {
    return res.status(400).json({ error: "Invalid cave id" });
  }

  const filePath = path.join(NARRATIVE_DIR, `${caveId}.json`);
  console.log(`[DELETE] Looking for file: ${filePath}`);

  // Check if narrative file exists
  if (!fs.existsSync(filePath)) {
    console.log(`[DELETE] File not found: ${filePath}`);
    return res.status(404).json({ error: "No narratives found for this cave" });
  }

  // Read existing narratives
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      console.error(`[DELETE] Error reading file ${filePath}:`, err);
      return res.status(500).json({ error: "Failed to read narratives" });
    }

    console.log(
      `[DELETE] File read successfully, length: ${data.length} characters`
    );
    console.log(`[DELETE] First 200 characters:`, data.substring(0, 200));

    try {
      let narratives = [];
      const fileData = JSON.parse(data);
      console.log(`[DELETE] JSON parsed successfully, type:`, typeof fileData);

      // Handle both old single narrative format and new array format
      if (Array.isArray(fileData)) {
        narratives = fileData;
        console.log(
          `[DELETE] Found array with ${narratives.length} narratives`
        );
      } else if (fileData.user) {
        // Convert old single narrative to array format
        narratives = [fileData];
        console.log(`[DELETE] Converted single narrative to array format`);
      } else {
        console.log(`[DELETE] Unexpected data format:`, Object.keys(fileData));
        return res
          .status(500)
          .json({ error: "Unexpected narrative file format" });
      }

      // Find the narrative to delete
      console.log(
        `[DELETE] Looking for narrative with timestamp: ${timestamp} and user: ${user}`
      );
      narratives.forEach((n, index) => {
        console.log(
          `[DELETE] Narrative ${index}: timestamp=${n.timestamp}, user=${n.user}`
        );
      });

      // Members may only delete their own narrative; admins/webmasters may
      // moderate anyone's.
      const narrativeIndex = narratives.findIndex(
        (n) =>
          n.timestamp === timestamp && (n.user === user || isModerator)
      );

      if (narrativeIndex === -1) {
        console.log(
          `[DELETE] Narrative not found in ${narratives.length} narratives`
        );
        return res.status(404).json({
          error:
            "Narrative not found or you do not have permission to delete it",
        });
      }

      console.log(`[DELETE] Found narrative at index ${narrativeIndex}`);

      // Store deletion info before removing
      const deletedNarrative = narratives[narrativeIndex];

      // Remove the narrative
      narratives.splice(narrativeIndex, 1);
      console.log(`[DELETE] Removed narrative, ${narratives.length} remaining`);

      // Log the deletion if requested
      if (logDeletion) {
        try {
          logNarrativeDeletion(caveId, deletedNarrative, user);
          console.log(`[DELETE] Deletion logged successfully`);
        } catch (logError) {
          console.error(`[DELETE] Error logging deletion:`, logError);
          // Continue with deletion even if logging fails
        }
      }

      // Save the updated narratives array
      if (narratives.length === 0) {
        // If no narratives left, delete the file
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) {
            console.error(`[DELETE] Error deleting empty file:`, unlinkErr);
            return res
              .status(500)
              .json({ error: "Failed to clean up empty narrative file" });
          }
          console.log(
            `[DELETE] Deleted empty narrative file for cave ${caveId}`
          );
          res.json({
            success: true,
            message: "Narrative deleted successfully and file removed",
            remainingNarratives: 0,
          });
        });
      } else {
        // Save remaining narratives
        fs.writeFile(
          filePath,
          JSON.stringify(narratives, null, 2),
          (writeErr) => {
            if (writeErr) {
              console.error(
                `[DELETE] Error saving updated narratives:`,
                writeErr
              );
              return res
                .status(500)
                .json({ error: "Failed to save updated narratives" });
            }
            console.log(
              `[DELETE] Updated narratives file for cave ${caveId}, ${narratives.length} remaining`
            );
            res.json({
              success: true,
              message: "Narrative deleted successfully",
              remainingNarratives: narratives.length,
            });
          }
        );
      }
    } catch (parseErr) {
      console.error(
        `[DELETE] Failed to parse JSON for cave ${caveId}:`,
        parseErr.message
      );
      console.error(`[DELETE] Parse error details:`, parseErr);
      console.error(`[DELETE] Raw file content:`, data);
      res.status(500).json({
        error: "Invalid narratives file format",
        details: parseErr.message,
        fileLength: data.length,
      });
    }
  });
});

// Function to log narrative deletions
function logNarrativeDeletion(caveId, deletedNarrative, deletedByUser) {
  const deletionLogPath = path.join(NARRATIVE_DIR, "deletion-log.json");

  // Fix the variable reference - use deletedNarrative instead of narrative
  let caveName = deletedNarrative.name || "Unknown Cave";
  if (!deletedNarrative.name && caveDatabase && caveDatabase.length > 0) {
    const cave = caveDatabase.find((c) => c.id === caveId);
    if (cave) caveName = cave.name || "Unnamed Cave";
  }

  const deletionEntry = {
    caveId: caveId,
    caveName: caveName,
    user: deletedByUser,
    originalUser: deletedNarrative.user,
    originalTimestamp: deletedNarrative.timestamp,
    timestamp: new Date().toISOString(),
    isDeleted: true,
    deletedNarrative: {
      originalUser: deletedNarrative.user,
      originalTimestamp: deletedNarrative.timestamp,
      wasEdited: !!deletedNarrative.lastModified,
    },
  };

  // Read existing deletion log
  let deletionLog = [];
  if (fs.existsSync(deletionLogPath)) {
    try {
      deletionLog = JSON.parse(fs.readFileSync(deletionLogPath, "utf8"));
    } catch (e) {
      console.log("Could not read deletion log, starting fresh");
    }
  }

  // Add new deletion entry
  deletionLog.push(deletionEntry);

  // Save updated deletion log
  fs.writeFileSync(deletionLogPath, JSON.stringify(deletionLog, null, 2));
  console.log(
    `Logged deletion of narrative by ${deletedNarrative.user} for cave ${caveId}`
  );
}

function cleanupImageUrls(htmlContent) {
  // Fix malformed ngrok URLs
  return htmlContent.replace(
    /https:\/\/[^\/\s]+\.ngrok-free\.app\s+https:\/\/[^\/\s]+\.ngrok-free\.apphttps:\/\/[^\/\s]+\.ngrok-free\.app/g,
    "https://fcs.caves.org"
  );
}

// Get all narratives across all caves for activity log
app.get("/get-all-narratives-log", authenticateToken, (req, res) => {
  try {
    const narrativesDir = NARRATIVE_DIR;

    if (!fs.existsSync(narrativesDir)) {
      return res.json([]);
    }

    const allNarratives = [];
    const files = fs
      .readdirSync(narrativesDir)
      .filter((file) => file.endsWith(".json") && file !== "deletion-log.json");

    // Process regular narrative files
    files.forEach((file) => {
      const caveId = file.replace(".json", "");
      const filePath = path.join(narrativesDir, file);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        let narratives = [];

        // Handle both array and single object formats
        if (Array.isArray(data)) {
          narratives = data;
        } else if (data.user) {
          narratives = [data];
        }

        // Add cave ID and name to each narrative
        narratives.forEach((narrative) => {
          // Prefer the name saved in the narrative; fall back to DB lookup
          let caveName = narrative.name || "Unknown Cave";
          if (!narrative.name && caveDatabase && caveDatabase.length > 0) {
            const cave = caveDatabase.find((c) => c.id === caveId);
            if (cave) caveName = cave.name || "Unnamed Cave";
          }

          allNarratives.push({
            caveId: caveId,
            caveName,
            user: narrative.user,
            timestamp: narrative.timestamp,
            lastModified: narrative.lastModified,
            isEdited: !!narrative.lastModified,
            isDeleted: false,
          });
        });
      } catch (e) {
        console.error(`Error reading narrative file ${file}:`, e);
      }
    });

    // Add deletion log entries
    const deletionLogPath = path.join(narrativesDir, "deletion-log.json");
    if (fs.existsSync(deletionLogPath)) {
      try {
        const deletionLog = JSON.parse(
          fs.readFileSync(deletionLogPath, "utf8")
        );
        deletionLog.forEach((deletion) => {
          allNarratives.push({
            caveId: deletion.caveId,
            caveName: deletion.name || deletion.caveName || "Unknown Cave",
            user: deletion.user, // User who deleted it
            timestamp: deletion.timestamp, // When it was deleted
            lastModified: deletion.timestamp,
            isEdited: false,
            isDeleted: true,
            originalUser: deletion.originalUser, // Original author
            originalTimestamp: deletion.originalTimestamp,
          });
        });
      } catch (e) {
        console.error("Error reading deletion log:", e);
      }
    }

    // Sort by most recent first (either timestamp or lastModified)
    allNarratives.sort((a, b) => {
      const dateA = new Date(a.lastModified || a.timestamp);
      const dateB = new Date(b.lastModified || b.timestamp);
      return dateB - dateA;
    });

    console.log(
      `Found ${allNarratives.length} total narrative activities for activity log`
    );
    res.json(allNarratives);
  } catch (error) {
    console.error("Error getting all narratives log:", error);
    res.status(500).json({ error: "Failed to load narratives log" });
  }
});

// Overridable so the test suite can point this at a throwaway directory.
const CAVE_PICTURES_DIR = process.env.CAVE_PICTURES_DIR
  ? path.resolve(process.env.CAVE_PICTURES_DIR)
  : path.join(__dirname, "httpdocs", "cave-pictures");
if (!fs.existsSync(CAVE_PICTURES_DIR)) {
  fs.mkdirSync(CAVE_PICTURES_DIR, { recursive: true });
}

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // This must match the directory actually served at /cave-pictures below,
    // otherwise uploaded images 404 for everyone.
    cb(null, CAVE_PICTURES_DIR);
  },
  filename: function (req, file, cb) {
    // Never trust the client-supplied original filename directly into a path
    // - strip it down to just a safe extension and generate the rest, so a
    // filename like "../../../httpdocs/evil.html" can't escape the upload
    // directory or overwrite another file.
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, "");
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: function (req, file, cb) {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, GIF, and WebP images are allowed"));
    }
    cb(null, true);
  },
});

app.post("/upload-narrative-image", authenticateToken, (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({ imageUrl: `/cave-pictures/${req.file.filename}` });
  });
});

const narrativesDir = NARRATIVE_DIR;

if (!fs.existsSync(narrativesDir)) {
  fs.mkdirSync(narrativesDir);
}

app.get("/get-narrative", authenticateToken, (req, res) => {
  const caveId = req.query.id;
  if (!caveId) return res.status(400).json({ error: "Missing caveId" });
  if (!isSafeRecordId(caveId)) {
    return res.status(400).json({ error: "Invalid cave id" });
  }

  const filePath = path.join(NARRATIVE_DIR, `${caveId}.json`);
  if (!fs.existsSync(filePath)) return res.json([]);

  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading narratives:", err);
      return res.status(500).json({ error: "Failed to load narratives" });
    }

    try {
      const fileData = JSON.parse(data);
      // Handle both old single narrative format and new array format
      if (Array.isArray(fileData)) {
        res.json(fileData);
      } else if (fileData.user) {
        // Convert old single narrative to array format
        res.json([fileData]);
      } else {
        res.json([]);
      }
    } catch (e) {
      console.error("Failed to parse narratives JSON:", e);
      res.json([]);
    }
  });
});

// Get list of caves that have narratives
app.get("/get-caves-with-narratives", authenticateToken, (req, res) => {
  try {
    const narrativesDir = NARRATIVE_DIR;

    if (!fs.existsSync(narrativesDir)) {
      return res.json([]);
    }

    const files = fs.readdirSync(narrativesDir);
    const caveIds = files
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(".json", ""))
      .filter((caveId) => {
        // Check if the file has actual narratives (not empty)
        try {
          const filePath = path.join(narrativesDir, `${caveId}.json`);
          const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
          // Handle both array and single object formats
          if (Array.isArray(data)) {
            return data.length > 0;
          } else if (data.user) {
            return true; // Single narrative object
          }
          return false;
        } catch {
          return false;
        }
      });

    console.log(`Found ${caveIds.length} caves with narratives`);
    res.json(caveIds);
  } catch (error) {
    console.error("Error getting caves with narratives:", error);
    res.status(500).json({ error: "Failed to load caves with narratives" });
  }
});

// Delete a specific image from a narrative
app.delete("/delete-narrative-image", authenticateToken, express.json(), (req, res) => {
  const { caveId, narrativeTimestamp, narrativeUser, imageIndex, imageUrl } =
    req.body;
  // Identity comes from the verified token, not a client-supplied
  // "currentUser" field (which previously let anyone pass someone else's
  // name and delete their images).
  const currentUser = req.user.username;
  const isModerator = ["admin", "webmaster"].includes(req.user.role);

  if (
    !caveId ||
    !narrativeTimestamp ||
    !narrativeUser ||
    imageIndex === undefined ||
    !imageUrl
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!isSafeRecordId(caveId)) {
    return res.status(400).json({ error: "Invalid cave id" });
  }

  // Verify user permission
  if (narrativeUser !== currentUser && !isModerator) {
    return res
      .status(403)
      .json({ error: "You can only delete images from your own narratives" });
  }

  const filePath = path.join(NARRATIVE_DIR, `${caveId}.json`);

  // Check if narrative file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "No narratives found for this cave" });
  }

  // Read existing narratives
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading narratives:", err);
      return res.status(500).json({ error: "Failed to read narratives" });
    }

    try {
      let narratives = [];
      const fileData = JSON.parse(data);

      // Handle both old single narrative format and new array format
      if (Array.isArray(fileData)) {
        narratives = fileData;
      } else if (fileData.user) {
        // Convert old single narrative to array format
        narratives = [fileData];
      }

      // Find the specific narrative
      const narrativeIndex = narratives.findIndex(
        (n) => n.timestamp === narrativeTimestamp && n.user === narrativeUser
      );

      if (narrativeIndex === -1) {
        return res.status(404).json({
          error:
            "Narrative not found or you do not have permission to modify it",
        });
      }

      const narrative = narratives[narrativeIndex];

      // Check if images array exists and has the specified index
      if (
        !narrative.images ||
        !Array.isArray(narrative.images) ||
        imageIndex >= narrative.images.length
      ) {
        return res.status(404).json({ error: "Image not found in narrative" });
      }

      // Get the image to delete
      const imageToDelete = narrative.images[imageIndex];

      // Verify the URL matches (security check)
      if (imageToDelete.url !== imageUrl) {
        return res.status(400).json({ error: "Image URL mismatch" });
      }

      // Extract filename from URL and delete the physical file
      let filename = "";
      try {
        // Handle different URL formats
        if (imageUrl.startsWith("/cave-pictures/")) {
          filename = imageUrl.replace("/cave-pictures/", "");
        } else if (imageUrl.includes("/cave-pictures/")) {
          filename = imageUrl.split("/cave-pictures/")[1];
        } else {
          // Extract filename from full URL
          const urlParts = imageUrl.split("/");
          filename = urlParts[urlParts.length - 1];
        }

        const imageFilePath = path.join(
          CAVE_PICTURES_DIR,
          path.basename(filename)
        );

        if (fs.existsSync(imageFilePath)) {
          fs.unlinkSync(imageFilePath);
          console.log(`Deleted image file: ${filename}`);
        } else {
          console.log(`Image file not found: ${imageFilePath}`);
        }
      } catch (fileError) {
        console.error("Error deleting image file:", fileError);
        // Continue with removing from narrative even if file deletion fails
      }

      // Remove the image from the narrative's images array
      narrative.images.splice(imageIndex, 1);

      // Update the last modified timestamp
      narrative.lastModified = new Date().toISOString();

      console.log(
        `Removed image ${imageIndex} from narrative by ${narrativeUser} for cave ${caveId}`
      );

      // Save the updated narratives
      fs.writeFile(
        filePath,
        JSON.stringify(narratives, null, 2),
        (writeErr) => {
          if (writeErr) {
            console.error("Error saving updated narratives:", writeErr);
            return res
              .status(500)
              .json({ error: "Failed to save updated narratives" });
          }

          console.log(
            `Updated narratives file for cave ${caveId} after image deletion`
          );
          res.json({
            success: true,
            message: "Image deleted successfully",
            remainingImages: narrative.images.length,
          });
        }
      );
    } catch (parseErr) {
      console.error("Failed to parse narratives JSON:", parseErr);
      res.status(500).json({ error: "Invalid narratives file format" });
    }
  });
});

// Download narrative image with proper headers
app.get("/download-narrative-image/:filename", authenticateToken, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(CAVE_PICTURES_DIR, filename);

  if (fs.existsSync(filePath)) {
    // Set appropriate headers for download
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    // Send the file
    res.sendFile(filePath);
    console.log(`Downloaded narrative image: ${filename}`);
  } else {
    res.status(404).json({ error: "Image file not found" });
  }
});

// Initialize global storage for database schemas
global.sqliteSchemas = {};

// GET /api/sqlite-hillshades/list
app.get("/api/sqlite-hillshades/list", authenticateToken, (req, res) => {
  console.log("→ [SERVER] GET /api/sqlite-hillshades/list");

  try {
    if (!fs.existsSync(sqliteHillshadesDir)) {
      console.log("Creating sqlite-hillshades directory...");
      fs.mkdirSync(sqliteHillshadesDir, { recursive: true });
      return res.json([]);
    }

    const files = fs
      .readdirSync(sqliteHillshadesDir)
      .filter(
        (file) =>
          file.endsWith(".sqlitedb") ||
          file.endsWith(".db") ||
          file.endsWith(".mbtiles")
      )
      .map((file) => {
        const filePath = path.join(sqliteHillshadesDir, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size,
          modified: stats.mtime,
        };
      });

    console.log(`Found ${files.length} SQLite hillshade files`);
    res.json(files);
  } catch (error) {
    console.error("Error listing SQLite hillshades:", error);
    res.status(500).json({ error: "Failed to list SQLite hillshades" });
  }
});

// GET /api/sqlite-hillshades/bounds/:filename - FIXED FOR CUSTOM COORDINATES
app.get("/api/sqlite-hillshades/bounds/:filename", authenticateToken, (req, res) => {
  const filename = path.basename(req.params.filename);
  const dbPath = path.join(sqliteHillshadesDir, filename);

  console.log(`→ [SERVER] GET /api/sqlite-hillshades/bounds/${filename}`);

  if (!Database) {
    return res.status(500).json({
      error: "better-sqlite3 not available",
      bounds: [
        [24.5, -87.5],
        [31.0, -79.8],
      ],
      minZoom: 0,
      maxZoom: 18,
      method: "error_fallback",
    });
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    // Get coordinate ranges and sample tile
    const ranges = db
      .prepare(
        `
      SELECT 
        MIN(z) as minZ, MAX(z) as maxZ,
        MIN(x) as minX, MAX(x) as maxX,
        MIN(y) as minY, MAX(y) as maxY,
        COUNT(*) as totalTiles
      FROM tiles
    `
      )
      .get();

    console.log(`Database ranges for ${filename}:`, ranges);

    // For now, return reasonable bounds for Florida cave mapping
    // You can adjust these based on your actual geographic coverage
    let bounds;

    if (filename.toLowerCase().includes("citrus")) {
      bounds = [
        [28.5, -82.8],
        [29.0, -82.2],
      ]; // Citrus County area
    } else if (filename.toLowerCase().includes("hernando")) {
      bounds = [
        [28.4, -82.7],
        [28.8, -82.3],
      ]; // Hernando County area
    } else if (filename.toLowerCase().includes("pasco")) {
      bounds = [
        [28.0, -82.8],
        [28.6, -82.2],
      ]; // Pasco County area
    } else if (filename.toLowerCase().includes("marion")) {
      bounds = [
        [28.8, -82.4],
        [29.4, -81.8],
      ]; // Marion County area
    } else if (filename.toLowerCase().includes("sumter")) {
      bounds = [
        [28.6, -82.2],
        [29.0, -81.8],
      ]; // Sumter County area
    } else {
      bounds = [
        [28.0, -83.0],
        [29.5, -81.5],
      ]; // General central Florida
    }

    const boundsData = {
      bounds: bounds,
      minZoom: ranges.minZ || 0,
      maxZoom: Math.min(ranges.maxZ + 5, 18), // Allow zooming beyond database max
      method: "county_based",
      tileCount: ranges.totalTiles,
      coordinateRanges: {
        x: [ranges.minX, ranges.maxX],
        y: [ranges.minY, ranges.maxY],
        z: [ranges.minZ, ranges.maxZ],
      },
    };

    console.log(`Bounds for ${filename}:`, boundsData);

    db.close();
    res.json(boundsData);
  } catch (error) {
    console.error(`Error getting bounds for ${filename}:`, error);
    res.status(500).json({
      error: error.message,
      bounds: [
        [28.0, -83.0],
        [29.5, -81.5],
      ],
      minZoom: 0,
      maxZoom: 18,
      method: "error_fallback",
    });
  }
});

// GET /api/sqlite-hillshades/tiles/:filename/:z/:x/:y - GEOGRAPHIC ALIGNMENT FIX
app.get("/api/sqlite-hillshades/tiles/:filename/:z/:x/:y", authenticateToken, (req, res) => {
  const { z, x, y } = req.params;
  const filename = path.basename(req.params.filename);
  const dbPath = path.join(sqliteHillshadesDir, filename);

  const webZ = parseInt(z);
  const webX = parseInt(x);
  const webY = parseInt(y);

  if (!Database || !fs.existsSync(dbPath)) {
    return res.status(404).send("Database file not found");
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    // Get the highest zoom level and tile bounds
    const maxZoom = db.prepare(`SELECT MAX(z) as maxZ FROM tiles`).get().maxZ;
    const bounds = db
      .prepare(
        `
      SELECT 
        MIN(x) as minX, MAX(x) as maxX,
        MIN(y) as minY, MAX(y) as maxY
      FROM tiles WHERE z = ?
    `
      )
      .get(maxZoom);

    // ADJUSTED geographic bounds for better alignment
    // Based on your tile coordinates, let's try different bounds
    let lat1, lat2, lng1, lng2;

    if (filename.toLowerCase().includes("citrus")) {
      // More precise Citrus County bounds
      lat1 = 28.75;
      lat2 = 29.15; // Slightly adjusted
      lng1 = -82.75;
      lng2 = -82.25; // Slightly adjusted
    } else {
      // Default bounds
      lat1 = 28.5;
      lat2 = 29.0;
      lng1 = -82.8;
      lng2 = -82.2;
    }

    function deg2num(lat_deg, lon_deg, zoom) {
      const lat_rad = (lat_deg * Math.PI) / 180;
      const n = Math.pow(2, zoom);
      const xtile = Math.floor(((lon_deg + 180) / 360) * n);
      const ytile = Math.floor(
        ((1 - Math.asinh(Math.tan(lat_rad)) / Math.PI) / 2) * n
      );
      return [xtile, ytile];
    }

    // Calculate web mercator bounds
    const [webMinX, webMaxY] = deg2num(lat1, lng1, webZ);
    const [webMaxX, webMinY] = deg2num(lat2, lng2, webZ);

    // Check if tile is in coverage area
    if (webX < webMinX || webX > webMaxX || webY < webMinY || webY > webMaxY) {
      return res.status(404).send("Outside coverage area");
    }

    // IMPROVED mapping with sub-pixel precision
    const webRangeX = webMaxX - webMinX;
    const webRangeY = webMaxY - webMinY;
    const dbRangeX = bounds.maxX - bounds.minX;
    const dbRangeY = bounds.maxY - bounds.minY;

    // Use floating point for better precision
    const normalizedX = (webX - webMinX) / webRangeX;
    const normalizedY = (webY - webMinY) / webRangeY;

    const targetDbX = bounds.minX + normalizedX * dbRangeX;
    const targetDbY = bounds.minY + normalizedY * dbRangeY;

    // Round to nearest integer for tile lookup
    const dbX = Math.round(targetDbX);
    const dbY = Math.round(targetDbY);

    console.log(
      `→ [TILE] ${filename}/${webZ}/${webX}/${webY} -> db(${maxZoom},${dbX},${dbY})`
    );

    // Try exact match first, then closest
    let row = db
      .prepare(
        `
      SELECT image FROM tiles WHERE z = ? AND x = ? AND y = ?
    `
      )
      .get(maxZoom, dbX, dbY);

    if (!row) {
      // Find closest tile if exact match doesn't exist
      row = db
        .prepare(
          `
        SELECT image, x, y, ABS(x - ?) + ABS(y - ?) as distance
        FROM tiles WHERE z = ?
        ORDER BY distance LIMIT 1
      `
        )
        .get(dbX, dbY, maxZoom);
    }

    if (row && row.image) {
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=3600");
      res.send(row.image);
    } else {
      res.status(404).send("No tiles found");
    }

    db.close();
  } catch (error) {
    console.error(`Database error:`, error);
    res.status(500).send(`Database error: ${error.message}`);
  }
});

// Add this endpoint to help calibrate geographic bounds
app.get("/api/sqlite-hillshades/calibrate/:filename", authenticateToken, (req, res) => {
  const filename = path.basename(req.params.filename);
  const dbPath = path.join(sqliteHillshadesDir, filename);

  if (!Database || !fs.existsSync(dbPath)) {
    return res.status(404).json({ error: "Database not found" });
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    const maxZoom = db.prepare(`SELECT MAX(z) as maxZ FROM tiles`).get().maxZ;

    // Get corner tiles to help determine geographic bounds
    const corners = db
      .prepare(
        `
      SELECT 
        MIN(x) as minX, MAX(x) as maxX,
        MIN(y) as minY, MAX(y) as maxY
      FROM tiles WHERE z = ?
    `
      )
      .get(maxZoom);

    // Get sample tiles at corners
    const cornerTiles = [
      db
        .prepare(
          `SELECT x, y FROM tiles WHERE z = ? AND x = ? AND y = ? LIMIT 1`
        )
        .get(maxZoom, corners.minX, corners.minY),
      db
        .prepare(
          `SELECT x, y FROM tiles WHERE z = ? AND x = ? AND y = ? LIMIT 1`
        )
        .get(maxZoom, corners.maxX, corners.minY),
      db
        .prepare(
          `SELECT x, y FROM tiles WHERE z = ? AND x = ? AND y = ? LIMIT 1`
        )
        .get(maxZoom, corners.minX, corners.maxY),
      db
        .prepare(
          `SELECT x, y FROM tiles WHERE z = ? AND x = ? AND y = ? LIMIT 1`
        )
        .get(maxZoom, corners.maxX, corners.maxY),
    ].filter((t) => t);

    db.close();

    res.json({
      filename,
      maxZoom,
      tileCorners: corners,
      cornerTiles,
      suggestedTestUrls: [
        `http://localhost:3000/api/sqlite-hillshades/tiles/${filename}/0/${corners.minX}/${corners.minY}`,
        `http://localhost:3000/api/sqlite-hillshades/tiles/${filename}/0/${corners.maxX}/${corners.maxY}`,
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add this debug route to check database structure
app.get("/api/sqlite-hillshades/debug/:filename", authenticateToken, (req, res) => {
  const filename = path.basename(req.params.filename);
  const dbPath = path.join(sqliteHillshadesDir, filename);

  if (!Database || !fs.existsSync(dbPath)) {
    return res.status(404).json({ error: "Database not found" });
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    // Check column names
    const columns = db.prepare("PRAGMA table_info(tiles)").all();

    // Get a sample tile to see what data is available
    const sample = db.prepare("SELECT * FROM tiles LIMIT 1").get();

    db.close();

    // Convert sample to show column names and data types (without binary data)
    const sampleInfo = {};
    if (sample) {
      Object.keys(sample).forEach((key) => {
        if (Buffer.isBuffer(sample[key])) {
          sampleInfo[key] = `<binary data, ${sample[key].length} bytes>`;
        } else {
          sampleInfo[key] = sample[key];
        }
      });
    }

    res.json({
      filename,
      columns: columns.map((c) => ({ name: c.name, type: c.type })),
      sampleData: sampleInfo,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TEMPORARY: Debug your specific database
app.get("/api/sqlite-hillshades/debug-db/:filename", authenticateToken, (req, res) => {
  const filename = path.basename(req.params.filename);
  const dbPath = path.join(sqliteHillshadesDir, filename);

  if (!Database || !fs.existsSync(dbPath)) {
    return res.status(404).json({ error: "Database not found" });
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    // Get all tables
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    console.log(
      `Tables in ${filename}:`,
      tables.map((t) => t.name)
    );

    // Get tiles table structure
    const columns = db.prepare("PRAGMA table_info(tiles)").all();
    console.log(`Columns in tiles table:`, columns);

    // Get a few sample rows
    const samples = db.prepare("SELECT * FROM tiles LIMIT 3").all();

    // Get total count
    const count = db.prepare("SELECT COUNT(*) as total FROM tiles").get();

    db.close();

    res.json({
      filename,
      tables: tables.map((t) => t.name),
      columns: columns,
      sampleCount: samples.length,
      totalTiles: count.total,
      sampleData: samples.map((row) => {
        const result = {};
        Object.keys(row).forEach((key) => {
          if (key === "tile_data" || key === "image") {
            result[key] = `<binary data, ${
              row[key] ? row[key].length : 0
            } bytes>`;
          } else {
            result[key] = row[key];
          }
        });
        return result;
      }),
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// TEMPORARY: Check what coordinates exist in your database
app.get("/api/sqlite-hillshades/test-coords/:filename", authenticateToken, (req, res) => {
  const filename = path.basename(req.params.filename);
  const dbPath = path.join(sqliteHillshadesDir, filename);

  if (!Database || !fs.existsSync(dbPath)) {
    return res.status(404).json({ error: "Database not found" });
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    // Get coordinate ranges
    const ranges = db
      .prepare(
        `
      SELECT 
        MIN(z) as minZ, MAX(z) as maxZ,
        MIN(x) as minX, MAX(x) as maxX,
        MIN(y) as minY, MAX(y) as maxY,
        COUNT(*) as totalTiles
      FROM tiles
    `
      )
      .get();

    // Get some sample coordinates
    const samples = db
      .prepare(
        `
      SELECT z, x, y FROM tiles 
      ORDER BY z, x, y 
      LIMIT 10
    `
      )
      .all();

    db.close();

    res.json({
      filename,
      ranges,
      samples,
      testUrls: samples.map(
        (tile) =>
          `http://localhost:3000/api/sqlite-hillshades/tiles/${filename}/${tile.z}/${tile.x}/${tile.y}`
      ),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all users (for account management)
app.get("/api/users", authenticateToken, requireRole("webmaster"), (req, res) => {
  try {
    const users = loadUsers();
    
    // Remove passwords from response for security
    const safeUsers = users.map(user => ({
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      nssNumber: user.nssNumber,
      role: user.role,
      status: user.status,
      created: user.created,
      lastLogin: user.lastLogin,
      loginAttempts: user.loginAttempts,
      isEmailVerified: user.isEmailVerified,
      twoFactorEnabled: !!user.twoFactorEnabled,
      allowedStates: getAllowedStatesForUser(user), // null for admin/webmaster = unrestricted
      loginIPs: user.loginIPs || [],
      isActive: user.status === "active"
    }));
    
    res.json(safeUsers);
  } catch (error) {
    console.error('Error loading users:', error);
    res.status(500).json({ error: "Failed to load users" });
  }
});

// Change user role
app.post("/api/change-user-role", authenticateToken, requireRole("webmaster"), express.json(), (req, res) => {
  try {
    const { username, newRole } = req.body;
    
    if (!username || !newRole) {
      return res.status(400).json({ error: "Username and new role are required" });
    }
    
    if (!['member', 'admin', 'webmaster'].includes(newRole)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    
    const users = loadUsers();
    const userIndex = users.findIndex(u => u.username === username);

    if (userIndex === -1) {
      return res.status(404).json({ error: "User not found" });
    }

    // Webmaster accounts are the top of the permission ladder and never
    // hold any other role - mirrors the account-management UI, which
    // doesn't offer a role control for webmaster rows at all, and the
    // existing "can't delete a webmaster" rule below.
    if (users[userIndex].role === 'webmaster') {
      return res.status(403).json({ error: "Cannot change a webmaster's role." });
    }

    users[userIndex].role = newRole;
    saveUsers(users);
    
    res.json({ success: true, message: `Role changed to ${newRole}` });
  } catch (error) {
    console.error('Error changing user role:', error);
    res.status(500).json({ error: "Failed to change user role" });
  }
});

// Grants/revokes which states a member account can see and submit for.
// Webmaster-only, same bucket as role changes and account deletion - not
// opened to admin, unlike the cave-data routes, since this is account
// administration. Admin/webmaster themselves are always unrestricted (see
// getAllowedStatesForUser) so this has no effect on them either way.
app.post("/api/change-user-states", authenticateToken, requireRole("webmaster"), express.json(), (req, res) => {
  try {
    const { username, allowedStates } = req.body;

    if (!username || !Array.isArray(allowedStates)) {
      return res.status(400).json({ error: "Username and allowedStates (array) are required" });
    }

    const validStateCodes = new Set(statesConfig.map((s) => s.code));
    if (!allowedStates.every((code) => validStateCodes.has(code))) {
      return res.status(400).json({ error: "One or more selected states are not recognized." });
    }

    const users = loadUsers();
    const userIndex = users.findIndex((u) => u.username === username);

    if (userIndex === -1) {
      return res.status(404).json({ error: "User not found" });
    }

    users[userIndex].allowedStates = allowedStates;
    saveUsers(users);

    res.json({ success: true, message: "Allowed states updated", allowedStates });
  } catch (error) {
    console.error('Error changing user states:', error);
    res.status(500).json({ error: "Failed to change user states" });
  }
});

// Toggle user status (active/inactive)
app.post("/api/toggle-user-status", authenticateToken, requireRole("webmaster"), express.json(), (req, res) => {
  try {
    const { username, isActive } = req.body;
    
    if (!username || typeof isActive !== 'boolean') {
      return res.status(400).json({ error: "Username and status are required" });
    }
    
    const users = loadUsers();
    const userIndex = users.findIndex(u => u.username === username);

    if (userIndex === -1) {
      return res.status(404).json({ error: "User not found" });
    }

    // Webmaster accounts can't be disabled from here - see the matching
    // note on /api/change-user-role.
    if (users[userIndex].role === 'webmaster') {
      return res.status(403).json({ error: "Cannot change a webmaster's status." });
    }

    users[userIndex].status = isActive ? "active" : "inactive";
    saveUsers(users);
    
    res.json({ success: true, message: `User ${isActive ? 'activated' : 'deactivated'}` });
  } catch (error) {
    console.error('Error toggling user status:', error);
    res.status(500).json({ error: "Failed to toggle user status" });
  }
});

// Delete user
app.delete("/api/delete-user", authenticateToken, requireRole("webmaster"), express.json(), (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }
    
    const users = loadUsers();
    const userIndex = users.findIndex(u => u.username === username);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Don't allow deleting webmaster accounts
    if (users[userIndex].role === 'webmaster') {
      return res.status(403).json({ error: "Cannot delete webmaster accounts" });
    }
    
    users.splice(userIndex, 1);
    saveUsers(users);
    
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// Get security logs
app.get("/api/security-logs", authenticateToken, requireRole("webmaster"), (req, res) => {
  try {
    // Create a simple security log from user login data
    const users = loadUsers();
    const logs = [];
    
    users.forEach(user => {
      if (user.lastLogin) {
        logs.push({
          timestamp: user.lastLogin,
          action: "Login",
          username: user.username,
          ipAddress: user.loginIPs ? user.loginIPs[user.loginIPs.length - 1] : "unknown",
          details: `Successful login`
        });
      }
      
      if (user.created) {
        logs.push({
          timestamp: user.created,
          action: "Account Created",
          username: user.username,
          ipAddress: "system",
          details: `Account created with role: ${user.role}`
        });
      }
    });
    
    // Sort by timestamp (newest first)
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json(logs);
  } catch (error) {
    console.error('Error loading security logs:', error);
    res.status(500).json({ error: "Failed to load security logs" });
  }
});

// Create account endpoint
// This is the public "Create New Account" form on the login page (see
// handleCreateAccount() in httpdocs/index.html) - it must stay reachable by
// anyone, so it's rate-limited instead of authenticated.
app.post("/api/create-account", authLimiter, express.json(), async (req, res) => {
  try {
    const { username, email, password, states } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required" });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      });
    }
    if (!Array.isArray(states) || states.length === 0) {
      return res.status(400).json({ error: "Please select at least one state." });
    }
    const validStateCodes = new Set(statesConfig.map((s) => s.code));
    if (!states.every((code) => validStateCodes.has(code))) {
      return res.status(400).json({ error: "One or more selected states are not recognized." });
    }

    const users = loadUsers();

    // Check if username or email already exists
    if (users.find((u) => u.username === username)) {
      return res.status(400).json({ error: "Username already exists" });
    }

    if (users.find((u) => u.email === email)) {
      return res.status(400).json({ error: "Email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create new user - never store the plaintext password. Starts
    // "pending" rather than "active": a self-registered account should not
    // get real access until a webmaster reviews and activates it.
    const newUser = {
      id: `member-${Date.now()}`,
      username,
      email,
      passwordHash,
      fullName: username, // Default to username
      nssNumber: "",
      role: "member",
      status: "pending",
      allowedStates: states,
      created: new Date().toISOString(),
      lastLogin: null,
      loginAttempts: 0,
      isEmailVerified: false,
      twoFactorEnabled: false,
      loginIPs: [req.ip],
    };

    users.push(newUser);
    saveUsers(users);

    res.json({
      success: true,
      message: "Account created. An administrator must approve it before you can log in.",
    });
  } catch (error) {
    console.error("Error creating account:", error);
    res.status(500).json({ error: "Failed to create account" });
  }
});

// Forgot password endpoint
app.post("/api/forgot-password", authLimiter, express.json(), async (req, res) => {
  // Always the same response, whether or not the email exists - this
  // endpoint must not be usable to enumerate registered accounts.
  const genericResponse = {
    success: true,
    message: "If the email exists, a reset link has been sent",
  };

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const users = loadUsers();
    const user = users.find((u) => u.email === email);

    if (!user) {
      return res.json(genericResponse);
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    user.resetTokenHash = hashResetToken(rawToken);
    user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    saveUsers(users);

    const origin = (process.env.ALLOWED_ORIGINS || "").split(",")[0].trim() || `${req.protocol}://${req.get("host")}`;
    const resetUrl = `${origin}/?resetToken=${rawToken}`;

    try {
      await sendPasswordResetEmail(user, resetUrl);
    } catch (mailErr) {
      // Don't let a mail-sending failure change the response (that would
      // leak account existence) or block the request - the [DEV] console
      // fallback inside sendPasswordResetEmail already covers the
      // no-SMTP-configured case; this branch is a real send() failure with
      // SMTP configured.
      console.error("Failed to send password reset email:", mailErr);
    }

    res.json(genericResponse);
  } catch (error) {
    console.error("Error handling forgot password:", error);
    res.status(500).json({ error: "Failed to process password reset" });
  }
});

// Complete a password reset started via /api/forgot-password.
app.post("/api/reset-password", authLimiter, express.json(), async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token and new password are required" });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      });
    }

    const users = loadUsers();
    const tokenHash = hashResetToken(token);
    const user = users.find((u) => u.resetTokenHash === tokenHash);

    if (!user || !user.resetTokenExpires || new Date(user.resetTokenExpires) < new Date()) {
      return res.status(400).json({
        error: "This reset link is invalid or has expired. Please request a new one.",
      });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    delete user.resetTokenHash;
    delete user.resetTokenExpires;
    user.loginAttempts = 0;
    user.lastFailedLogin = null;
    saveUsers(users);

    res.json({ success: true, message: "Password updated. You can now log in with your new password." });
  } catch (error) {
    console.error("Error resetting password:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// Self-service password change for an already-logged-in user (as opposed to
// /api/reset-password, which is for someone who's lost access and needs an
// emailed link). Requires the current password, same as disabling 2FA - a
// hijacked session token alone isn't enough to take over the account.
app.post("/api/change-password", authLimiter, authenticateToken, express.json(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required" });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      });
    }

    const users = loadUsers();
    const user = users.find((u) => u.username === req.user.username);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const passwordMatches =
      !!user.passwordHash && (await bcrypt.compare(currentPassword, user.passwordHash));
    if (!passwordMatches) {
      return res.status(401).json({ error: "Incorrect current password." });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.loginAttempts = 0;
    user.lastFailedLogin = null;
    saveUsers(users);

    res.json({ success: true, message: "Password updated." });
  } catch (error) {
    console.error("Error changing password:", error);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// Every real Florida cave ID predating multi-state support looks like this:
// a single "F", exactly 2 letters (the county code), then digits. Used only
// as a fallback for records written before the explicit state/county fields
// existed - never for anything else, so it can't misfire on a new state's
// (2-letter-prefixed) IDs.
const LEGACY_FLORIDA_ID = /^F([A-Z]{2})\d+$/;

// The authoritative source of a cave's state/county is now the explicit
// `state`/`county` fields on the record - this only exists to fill in
// whichever of those a legacy Florida record is missing, parsed out of its
// ID. Replaces what used to be 6 separate `cave.id.substring(1, 3)` calls
// scattered across this file, all of which assumed a fixed 1-character
// state prefix that no longer holds once other states exist.
function resolveCaveStateAndCounty(cave) {
  if (!cave) return { state: null, county: null };
  let state = cave.state || null;
  let county = cave.county || null;
  if ((!state || !county) && cave.id) {
    const match = cave.id.match(LEGACY_FLORIDA_ID);
    if (match) {
      state = state || "FL";
      county = county || match[1];
    }
  }
  return { state, county };
}

// Looks up the ID prefix a state generates new cave IDs with (see
// config/states.json / scripts/generate-states-config.js) - "F" for
// Florida (preserving its existing, real IDs exactly), each other state's
// own 2-letter USPS code. Falls back to the state code itself if the state
// isn't in the config, which should never happen in practice but keeps
// this total rather than throwing.
function getCaveIdPrefix(stateCode) {
  const state = statesConfig.find((s) => s.code === stateCode);
  return state ? state.caveIdPrefix : stateCode;
}

function generateNextCaveId(stateCode, countyCode, existingCaves) {
  const prefix = getCaveIdPrefix(stateCode);

  // Filter for caves in this exact state + county, using the explicit
  // fields (with the legacy fallback above) rather than re-deriving them
  // from a fixed-offset substring of the ID, which broke the moment a
  // state's prefix could be more than one character.
  const matchingCaves = existingCaves.filter((cave) => {
    const resolved = resolveCaveStateAndCounty(cave);
    return resolved.state === stateCode && resolved.county === countyCode;
  });

  // Find the highest cave number for this state+county
  let maxNumber = 0;
  matchingCaves.forEach((cave) => {
    const caveNumber = parseInt(cave.id.slice(prefix.length + countyCode.length), 10);
    if (!isNaN(caveNumber) && caveNumber > maxNumber) {
      maxNumber = caveNumber;
    }
  });

  // Return the next sequential number
  const nextNumber = maxNumber + 1;
  const paddedNumber = nextNumber.toString().padStart(3, "0");
  return `${prefix}${countyCode}${paddedNumber}`;
}

// Start server. Guarded so the test suite can `require("../server")` to get
// the Express app (for supertest) without also binding a real port.
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Webmaster portal running at http://localhost:${PORT}`);
    console.log("Cave maps directories:");
    console.log("  - GeoTIFF files: ./cave-maps/geotiff/");
    console.log("  - Shapefiles: ./cave-maps/shapefiles/");
    console.log("  - SQLite Hillshades: ./cave-maps/sqlite-hillshades/");
  });
}

module.exports = app;
