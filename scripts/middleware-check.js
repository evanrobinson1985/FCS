// Diagnostic: configures the exact same middleware server.js does - helmet
// (with its full CSP config), cors (with the real origin-check function),
// the auth rate limiter, and all three multer instances (memory + disk
// storage) - with zero of the ~100 real routes registered. Every other
// piece of server.js's startup (deps, full init/data-loading) is already
// confirmed fast and working under Passenger; this is what's left.
const t0 = Date.now();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const steps = [];
function step(name, fn) {
  const start = Date.now();
  try {
    fn();
    steps.push({ name, ms: Date.now() - start, ok: true });
  } catch (err) {
    steps.push({ name, ms: Date.now() - start, ok: false, error: err.message, stack: err.stack });
  }
}

const app = express();
const isProduction = process.env.NODE_ENV === "production";

step("helmet", () => {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.quilljs.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.quilljs.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
          fontSrc: ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "data:"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          connectSrc: ["'self'", "https:"],
          workerSrc: ["'self'", "blob:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          "upgrade-insecure-requests": isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    })
  );
});

step("cors", () => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://fcs.caves.org").split(",").map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    })
  );
});

step("authLimiter (rateLimit)", () => {
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please try again in a few minutes." },
    skip: () => process.env.NODE_ENV === "test",
  });
});

step("caveImportUpload (multer memoryStorage)", () => {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (![".xlsx", ".xls", ".csv"].includes(ext)) return cb(new Error(`Unsupported file type: ${ext}`));
      cb(null, true);
    },
  });
});

step("caveMapUpload (multer diskStorage)", () => {
  const caveMapsDir = process.env.CAVE_MAPS_DIR ? path.resolve(process.env.CAVE_MAPS_DIR) : path.join(__dirname, "..", "cave-maps");
  const geotiffDir = path.join(caveMapsDir, "geotiff");
  const shapefilesDir = path.join(caveMapsDir, "shapefiles");
  multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, ext === ".tif" || ext === ".tiff" ? geotiffDir : shapefilesDir);
      },
      filename: (req, file, cb) => cb(null, file.originalname),
    }),
  });
});

step("narrative upload (multer memoryStorage)", () => {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
});

const totalMs = Date.now() - t0;
const allOk = steps.every((s) => s.ok);

app.use((req, res) => {
  res.json({ totalMs, allOk, steps });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`middleware-check listening on port ${port}, totalMs=${totalMs}, allOk=${allOk}`);
});
