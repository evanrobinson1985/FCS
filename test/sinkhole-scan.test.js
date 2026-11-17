// The sinkhole scan's depression finder (httpdocs/js/sinkhole-scan.js runs it in the browser).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { window: {}, document: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "httpdocs", "js", "sinkhole-scan.js"), "utf8"), ctx);
const { analyze } = ctx.window.SinkholeScan;
const FT = 3.28084;

// gently sloping ground with LiDAR-like noise (1 m cells), plus features at known spots
function terrain(W, H, features) {
  let s = 11; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const z = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 30 + 0.004 * x + 0.003 * y + (rnd() - 0.5) * 0.06;
    for (const f of features) {
      if (f.ditch) { if (Math.abs(x - f.x) < f.len / 2 && Math.abs(y - f.y) < 3) v -= f.depth * (1 - Math.abs(y - f.y) / 3); continue; }
      const d = Math.hypot(x - f.x, y - f.y); if (d >= f.r) continue;
      const dep = f.depth * (1 - (d / f.r) ** 2);
      if (f.water && dep > f.depth - f.water) { v = 30 + 0.004 * f.x + 0.003 * f.y - (f.depth - f.water); continue; }
      v -= dep;
    }
    z[y * W + x] = v;
  }
  for (let k = 0; k < 150; k++) z[Math.floor(rnd() * W * H)] -= 0.15; // single-cell pits
  return z;
}
const opts = { minDepthM: 2 / FT, minDiamM: 15 / FT, maxElong: 4 };
const near = (found, x, y) => found.find((f) => Math.hypot(f.x - x, f.y - y) < 4);

test("finds sinkholes with the right depth and size, deepest first", () => {
  const W = 400, H = 400;
  const r = analyze(terrain(W, H, [{ x: 100, y: 100, r: 15, depth: 4 }, { x: 300, y: 250, r: 6, depth: 1.5 }]), W, H, 1, opts);
  assert.equal(r.found.length, 2);
  assert.ok(near(r.found, 100, 100) && near(r.found, 300, 250));
  assert.equal(r.found[0], near(r.found, 100, 100), "deepest first");
  assert.ok(Math.abs(r.found[0].depthM - 4) < 0.2, `depth ${r.found[0].depthM}`);
  assert.ok(Math.abs(r.found[0].diamM - 30) < 4, `width ${r.found[0].diamM}`);
});

test("ignores noise, and depressions that are too small, too shallow, or cut by the edge", () => {
  const W = 400, H = 400;
  const r = analyze(terrain(W, H, [
    { x: 100, y: 100, r: 1.5, depth: 1 },   // 3 m across
    { x: 250, y: 250, r: 20, depth: 0.3 },  // 1 ft deep
    { x: 1, y: 200, r: 18, depth: 3 },      // half outside the scanned area
  ]), W, H, 1, opts);
  assert.equal(r.found.length, 0);
});

test("leaves out long narrow ditches unless asked to keep them, and flags water", () => {
  const W = 400, H = 400;
  const z = terrain(W, H, [{ ditch: true, x: 200, y: 100, len: 160, depth: 1.2 }, { x: 150, y: 280, r: 25, depth: 3, water: 1.2 }]);
  const r = analyze(z, W, H, 1, opts);
  assert.equal(r.found.length, 1);
  assert.equal(r.found[0].flatBottom, true, "a pond's flat surface marks it as holding water");
  const keepDitches = analyze(terrain(W, H, [{ ditch: true, x: 200, y: 100, len: 160, depth: 1.2 }]), W, H, 1, { ...opts, maxElong: 0 });
  assert.equal(keepDitches.found.length, 1);
  assert.ok(keepDitches.found[0].elong > 4);
});

test("treats missing elevation as somewhere water can drain to", () => {
  const W = 200, H = 200, z = terrain(W, H, [{ x: 100, y: 100, r: 15, depth: 3 }]);
  for (let y = 95; y < 105; y++) for (let x = 100; x < 200; x++) z[y * W + x] = -9999; // a no-data strip into the sinkhole
  assert.equal(analyze(z, W, H, 1, opts).found.length, 0);
});

test("each result carries an outline that matches its size", () => {
  const W = 300, H = 300;
  const r = analyze(terrain(W, H, [{ x: 150, y: 150, r: 20, depth: 3 }]), W, H, 1, opts);
  assert.equal(r.found.length, 1);
  const ring = r.found[0].outline;
  assert.ok(ring.length >= 8 && ring.length < 200, `a simplified ring, got ${ring.length} points`);
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]; a += x1 * y2 - x2 * y1; }
  const traced = Math.abs(a) / 2, expected = r.found[0].areaM2;
  // traced through cell centres, so a little smaller than the cell count
  assert.ok(traced > expected * 0.8 && traced <= expected * 1.02, `outline area ${traced} vs ${expected}`);
  assert.ok(ring.every(([x, y]) => Math.hypot(x - 150, y - 150) < 22), "the outline sits round the sinkhole");
});
