/*
 * Sinkhole scan for the Interactive Map.
 *
 * Adds a "Sink Scan" button to the map. Anyone logged in can scan the whole map
 * view, or drag a box, for closed depressions in the USGS 3DEP bare-earth
 * LiDAR elevation: low spots that water can't drain out of. In Florida's
 * karst those are mostly sinkholes, so they are good places to look for
 * caves - though ponds, borrow pits and spots where a road embankment blocks
 * drainage show up too, so every result is a candidate to check, not a find.
 * Depressions that already have a cave in the database are left out.
 *
 * How it works:
 *   1. download the elevation grid for the area (same service and code as the
 *      3D view - js/terrain3d.js must be loaded first);
 *   2. "fill" every depression to the level where water would spill out of it
 *      (Priority-Flood, Barnes et al. 2014) - the filled depth is how deep the
 *      depression is at each spot;
 *   3. group the filled cells into depressions, split each into its separate
 *      pits, and keep the ones deep and wide enough to matter;
 *   4. tell them apart from the man-made features that also hold water in LiDAR
 *      (standard karst-mapping steps, e.g. Doctor & Young 2013, Wu et al. 2016):
 *      - a morphological opening trims any ditch or drain running off a
 *        depression, so its size and shape are of the depression itself;
 *      - shape: how long and narrow, and how round (4 pi A / P^2) - a ditch;
 *      - straight sides (Douglas-Peucker): a straight edge about as long as
 *        the depression is wide - a dug basin, field edge or embankment;
 *      - roads: the US Census road and railroad map (TIGERweb) is overlaid,
 *        and depressions that run along a road are marked - roadside ditches,
 *        and low ground split in two by a road embankment.
 *      Each of those is a filter in the results, on by default, that can be
 *      turned off to see everything.
 * Steps 2-4 (apart from the road check) run in a background worker, so the page
 * stays responsive. The elevation (USGS) and the road map (US Census) are
 * fetched by the browser straight from those public services, for the scanned
 * area only; nothing is sent to this site's server.
 *
 * Usage: SinkholeScan.attachControl(map, { getCaves: () => [{ id, name, lat, lng }, ...] });
 */
(function () {
  'use strict';

  // Areas are scanned at 1 m detail (the best 3DEP has) in sections of up to 2 x 2 km, which overlap
  // by 200 m so a depression lying across the line between two sections is whole in one of them.
  // The results of all sections are combined into one list.
  const SECTION_M = 2000;          // an area up to this size (each way) is scanned in one go
  const CORE_M = 1600;             // bigger areas: sections own a 1.6 km square each...
  const OVERLAP_M = 200;           // ...plus 200 m around it that they share with their neighbours
  const SECTION_BUDGET = 4.2e6;    // cells per section: 2 x 2 km at 1 m, with room for rounding
  const MAX_AREA_KM2 = 100;        // about 10 x 10 km: 49 sections, a few hundred MB of elevation data
  const MB_PER_SECTION = 10;       // rough download size of one section, for the estimate shown first
  const FT = 3.28084;
  const MAX_LISTED = 300;
  // A scan keeps every depression at least this deep and wide; the filters on the results then
  // narrow what's shown, so they can be changed (either way) without scanning again.
  const SCAN_FLOOR = { minDepthM: 1 / 3.28084, minDiamM: 2 / 3.28084, maxElong: 0 };
  // The stops on the min/max sliders: fine at small sizes, coarse at big ones, and "no limit" at the top.
  const FILTER_STOPS = {
    depth: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100, Infinity],
    width: [2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, Infinity],
  };
  // The tests the results can be filtered by (see the header). Thresholds come from scans of Florida
  // LiDAR with known sinkholes, ditches, road crossings and retention ponds side by side.
  const ROAD_BUFFER_M = 15;     // a road's centre line, plus its shoulders and roadside ditch
  const ROAD_SHARE = 0.2;       // ...along at least this share of its outline (a round one touching a road: 0.14)
  const STRAIGHT_SHARE = 0.8;   // a straight side at least this share of the width (and 20 m)
  const isDitch = (f) => (f.narrow && f.elong >= 2) || f.elong > 4 || f.circularity < 0.2;
  const hasStraightSide = (f) => f.straightRunM >= Math.max(20, STRAIGHT_SHARE * f.diamM);
  const alongRoad = (f) => f.roadShare != null && f.roadShare >= ROAD_SHARE;
  // US Census TIGERweb: primary and secondary roads, local roads, railroads (all public roads in the US)
  const ROADS_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer';
  const ROAD_LAYERS = [2, 6, 8, 9];
  const MAX_MARKERS = 2000;
  const MAX_OUTLINES = 3000;

  // ---------- the analysis (runs in a worker; must not use anything outside itself) ----------
  function analyze(dem, W, H, res, opts) {
    const N = W * H, ND = -100;
    const minDepth = opts.minDepthM, minDiam = opts.minDiamM, maxElong = opts.maxElong;
    const filled = new Float32Array(dem);
    const closed = new Uint8Array(N);

    // binary min-heap of cell indices keyed by filled elevation
    let hsize = 0;
    const hidx = new Int32Array(N), hkey = new Float32Array(N);
    function hpush(i, k) {
      let p = hsize++;
      while (p > 0) { const q = (p - 1) >> 1; if (hkey[q] <= k) break; hidx[p] = hidx[q]; hkey[p] = hkey[q]; p = q; }
      hidx[p] = i; hkey[p] = k;
    }
    function hpop() {
      const top = hidx[0], li = hidx[--hsize], lk = hkey[hsize];
      let p = 0;
      for (;;) {
        let c = 2 * p + 1; if (c >= hsize) break;
        if (c + 1 < hsize && hkey[c + 1] < hkey[c]) c++;
        if (hkey[c] >= lk) break;
        hidx[p] = hidx[c]; hkey[p] = hkey[c]; p = c;
      }
      hidx[p] = li; hkey[p] = lk;
      return top;
    }
    // cells below the current spill level: a plain queue (Priority-Flood+), much faster than the heap
    const pit = new Int32Array(N); let ph = 0, pt = 0;

    // Seeds: the edge of the area, and every cell next to missing data. Water can always leave
    // through those, so a depression touching the edge of the scan is (correctly) not reported.
    for (let i = 0; i < N; i++) if (dem[i] < ND) closed[i] = 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (closed[i]) continue;
      let edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      if (!edge) edge = dem[i - 1] < ND || dem[i + 1] < ND || dem[i - W] < ND || dem[i + W] < ND;
      if (edge) { closed[i] = 1; hpush(i, filled[i]); }
    }
    const dx = [-1, 0, 1, -1, 1, -1, 0, 1], dy = [-1, -1, -1, 0, 0, 1, 1, 1];
    while (hsize > 0 || ph < pt) {
      const c = ph < pt ? pit[ph++] : hpop();
      const cx = c % W, cy = (c / W) | 0, cv = filled[c];
      for (let k = 0; k < 8; k++) {
        const nx = cx + dx[k], ny = cy + dy[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx; if (closed[n]) continue;
        closed[n] = 1;
        if (filled[n] <= cv) { filled[n] = cv; pit[pt++] = n; } else hpush(n, filled[n]);
      }
      if (ph === pt) { ph = 0; pt = 0; }
    }

    // group filled cells (deeper than LiDAR noise) into depressions
    const EPS = 0.05;
    const label = new Int32Array(N); let n = 0;
    const stack = new Int32Array(N);
    const regions = [];
    for (let s = 0; s < N; s++) {
      if (label[s] || dem[s] < ND || filled[s] - dem[s] < EPS) continue;
      n++; let sp = 0; stack[sp++] = s; label[s] = n;
      const r = { id: n, spill: filled[s], cellsList: [] };
      while (sp) {
        const c = stack[--sp], cx = c % W, cy = (c / W) | 0;
        if (filled[c] > r.spill) r.spill = filled[c];
        r.cellsList.push(c);
        for (let k = 0; k < 8; k++) {
          const nx = cx + dx[k], ny = cy + dy[k];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (label[q] || dem[q] < ND || filled[q] - dem[q] < EPS) continue;
          label[q] = n; stack[sp++] = q;
        }
      }
      regions.push(r);
    }

    // The edge of a set of cells, in cell coordinates: Moore neighbour tracing round the cell centres.
    function traceOf(cells) {
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (const c of cells) { const x = c % W, y = (c / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const w = x1 - x0 + 3, h = y1 - y0 + 3, m = new Uint8Array(w * h);
      for (const c of cells) m[(((c / W) | 0) - y0 + 1) * w + (c % W) - x0 + 1] = 1;
      let sx = -1, sy = -1;
      for (let i = 0; i < w * h && sx < 0; i++) if (m[i]) { sx = i % w; sy = (i / w) | 0; }
      const nb = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
      const pts = [[sx, sy]]; let px = sx, py = sy, bi = 4, guard = 0;
      while (guard++ < 4 * w * h + 8) {
        let f = -1;
        for (let k = 1; k <= 8; k++) { const di = (bi + k) % 8, nx = px + nb[di][0], ny = py + nb[di][1]; if (nx >= 0 && ny >= 0 && nx < w && ny < h && m[ny * w + nx]) { f = di; break; } }
        if (f < 0) break;
        px += nb[f][0]; py += nb[f][1]; bi = (f + 4) % 8;
        if (px === sx && py === sy) break;
        pts.push([px, py]);
      }
      return pts.map(([x, y]) => [x + x0 - 1, y + y0 - 1]);
    }
    // ...simplified for drawing: drop points that don't change the shape (Douglas-Peucker)
    function simplify(pts) {
      if (pts.length < 4) return pts.slice();
      const keepPt = new Uint8Array(pts.length); keepPt[0] = 1; keepPt[pts.length - 1] = 1;
      const st = [[0, pts.length - 1]];
      while (st.length) {
        const [a, b] = st.pop(); if (b - a < 2) continue;
        const [ax, ay] = pts[a], [bx, by] = pts[b], len = Math.hypot(bx - ax, by - ay) || 1;
        let dm = 0, ix = -1;
        for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * (by - ay) - (pts[i][1] - ay) * (bx - ax)) / len; if (d > dm) { dm = d; ix = i; } }
        if (dm > 0.75) { keepPt[ix] = 1; st.push([a, ix], [ix, b]); }
      }
      return pts.filter((_, i) => keepPt[i]);
    }
    function outlineOf(cells) { return simplify(traceOf(cells)); }

    // ---- one result per pit, not per depression ----
    // A depression often holds several sinkholes: a broad hollow with pits in its floor, or two pits side
    // by side. Reported at its rim it would be ONE wide result, hiding the sinkholes in it. So each
    // depression is broken down by flooding it from the bottom up (cells in order of height, joined to the
    // neighbouring pools they touch): where two pools that are each a real pit (at least minDepth deep and
    // minDiam wide) meet, each is recorded as a sinkhole of its own, with its depth and size at the level
    // where it would spill into the other. A depression with no such split is reported whole, as before.
    const parent = new Int32Array(N).fill(-1);
    const find = (c) => { let r = c; while (parent[r] !== r) r = parent[r]; while (parent[c] !== r) { const nx = parent[c]; parent[c] = r; c = nx; } return r; };
    const minCells = Math.max(1, Math.PI * (minDiam / 2) ** 2 / (res * res));
    function pitsOf(reg) {
      const order = Int32Array.from(reg.cellsList).sort((a, b) => dem[a] - dem[b]);
      const pool = new Map();   // root -> { cells: [...], min, hasChildren }
      const out = [];
      for (let k = 0; k < order.length; k++) {
        const c = order[k], z = dem[c], cx = c % W, cy = (c / W) | 0;
        const roots = [];
        for (let d = 0; d < 8; d++) {
          const nx = cx + dx[d], ny = cy + dy[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (parent[q] < 0 || label[q] !== reg.id) continue;
          const rt = find(q); if (!roots.includes(rt)) roots.push(rt);
        }
        if (!roots.length) { parent[c] = c; pool.set(c, { cells: [c], min: z, hasChildren: false }); continue; }
        let splitHere = false;
        if (roots.length > 1) {
          const real = roots.filter((rt) => { const p = pool.get(rt); return z - p.min >= minDepth && p.cells.length >= minCells; });
          if (real.length > 1) {
            for (const rt of real) { const p = pool.get(rt); if (!p.hasChildren) out.push({ cells: p.cells.slice(), spill: z }); }
            splitHere = true;
          }
        }
        // merge everything into the biggest pool, then add this cell
        let big = roots[0];
        for (const rt of roots) if (pool.get(rt).cells.length > pool.get(big).cells.length) big = rt;
        const B = pool.get(big);
        for (const rt of roots) {
          if (rt === big) continue;
          const p = pool.get(rt);
          for (const x of p.cells) B.cells.push(x);
          if (p.min < B.min) B.min = p.min;
          B.hasChildren = B.hasChildren || p.hasChildren;
          parent[rt] = big; pool.delete(rt);
        }
        if (splitHere) B.hasChildren = true;
        parent[c] = big; B.cells.push(c);
      }
      for (const p of pool.values()) if (!p.hasChildren) out.push({ cells: p.cells, spill: reg.spill });
      return out;
    }
    // the measurements of one pit, from its cells and the level it fills to
    function measure(cells, spill) {
      const r = { cells: cells.length, maxDepth: 0, deepest: cells[0], volume: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, spill, cellsList: cells };
      for (const c of cells) {
        const cx = c % W, cy = (c / W) | 0, d = spill - dem[c];
        r.volume += d; r.sx += cx; r.sy += cy; r.sxx += cx * cx; r.syy += cy * cy; r.sxy += cx * cy;
        if (d > r.maxDepth) { r.maxDepth = d; r.deepest = c; }
      }
      return r;
    }
    const pits = [];
    for (const reg of regions) for (const p of pitsOf(reg)) pits.push(measure(p.cells, p.spill));

    // ---- describing each pit ----
    // Each pit is measured the way the karst-mapping literature does (e.g. Doctor & Young 2013,
    // Wu et al. 2016), so the results can be told apart from the features that also hold water
    // in LiDAR: ditches, road embankments that dam a swale, and dug ponds.
    const cellArea = res * res;
    const R_OPEN = Math.max(1, Math.round(3 / res));   // trims parts narrower than about 7 m (a ditch)
    const inPit = new Int32Array(N);                    // set-membership stamps (no clearing between uses)
    let pitStamp = 0;

    // Morphological opening (erode, then dilate, by R_OPEN): what's left is the depression's
    // body without any ditch or drain running off it. Done with a chamfer distance transform.
    function openingOf(cells) {
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (const c of cells) { const x = c % W, y = (c / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const P = R_OPEN + 1, w = x1 - x0 + 1 + 2 * P, h = y1 - y0 + 1 + 2 * P, n = w * h;
      const at = (c) => (((c / W) | 0) - y0 + P) * w + (c % W) - x0 + P;
      const m = new Uint8Array(n); for (const c of cells) m[at(c)] = 1;
      const BIG = 1e9, D1 = 1, D2 = Math.SQRT2;
      const dist = (seedFn) => {
        const d = new Float32Array(n);
        for (let i = 0; i < n; i++) d[i] = seedFn(i) ? 0 : BIG;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          const i = y * w + x; let v = d[i];
          v = Math.min(v, d[i - 1] + D1, d[i - w] + D1, d[i - w - 1] + D2, d[i - w + 1] + D2); d[i] = v;
        }
        for (let y = h - 2; y > 0; y--) for (let x = w - 2; x > 0; x--) {
          const i = y * w + x; let v = d[i];
          v = Math.min(v, d[i + 1] + D1, d[i + w] + D1, d[i + w + 1] + D2, d[i + w - 1] + D2); d[i] = v;
        }
        return d;
      };
      const toEdge = dist((i) => !m[i]);
      const eroded = new Uint8Array(n); let any = false;
      for (let i = 0; i < n; i++) if (m[i] && toEdge[i] > R_OPEN) { eroded[i] = 1; any = true; }
      if (!any) return [];
      const toCore = dist((i) => eroded[i]);
      return cells.filter((c) => toCore[at(c)] <= R_OPEN + 0.01);
    }
    // the connected part of a set of cells that holds (or comes nearest) the given cell
    function partWith(cells, near) {
      const stamp = ++pitStamp; for (const c of cells) inPit[c] = stamp;
      let seed = near;
      if (inPit[near] !== stamp) {
        let best = Infinity; const nx0 = near % W, ny0 = (near / W) | 0;
        for (const c of cells) { const d = Math.hypot(c % W - nx0, ((c / W) | 0) - ny0); if (d < best) { best = d; seed = c; } }
      }
      const out = [seed], seen = ++pitStamp; inPit[seed] = seen;
      for (let k = 0; k < out.length; k++) {
        const c = out[k], cx = c % W, cy = (c / W) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = cx + dx[d], ny = cy + dy[d]; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx; if (inPit[q] !== stamp) continue;
          inPit[q] = seen; out.push(q);
        }
      }
      return out;
    }
    const keep = [];
    for (const r of pits) {
      const area0 = r.cells * cellArea, diam0 = 2 * Math.sqrt(area0 / Math.PI);
      if (r.maxDepth < minDepth || diam0 < minDiam) continue;
      // the body of the pit, with any ditch running off it trimmed away
      const opened = openingOf(r.cellsList);
      const narrow = opened.length === 0;
      const body = narrow ? r.cellsList : partWith(opened, r.deepest);
      const m = body === r.cellsList ? r : measure(body, r.spill);
      const area = m.cells * cellArea, diam = 2 * Math.sqrt(area / Math.PI);
      if (m.maxDepth < minDepth || diam < minDiam) continue;
      // shape: how long and narrow (ratio of the two axes of its spread)
      const mx = m.sx / m.cells, my = m.sy / m.cells;
      const vxx = m.sxx / m.cells - mx * mx, vyy = m.syy / m.cells - my * my, vxy = m.sxy / m.cells - mx * my;
      const tr = vxx + vyy, det = vxx * vyy - vxy * vxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
      const elong = Math.sqrt(l1 / l2);
      if (maxElong && elong > maxElong) continue;
      // roundness (4 pi A / P^2, the isoperimetric quotient: 1 for a circle, near 0 for a ditch)
      const ring = traceOf(body);
      let perim = 0, ringArea = 0;
      for (let i = 0; i < ring.length; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]; perim += Math.hypot(x2 - x1, y2 - y1); ringArea += x1 * y2 - x2 * y1; }
      ringArea = Math.abs(ringArea) / 2;
      const circularity = ring.length < 4 || !perim ? 1 : Math.min(1, 4 * Math.PI * ringArea / (perim * perim));
      // Straight sides: the longest stretch of the outline that lies within 1.2 m of one straight line
      // (the longest edge once the outline is simplified to that tolerance, Douglas-Peucker). Dug
      // basins, borrow pits, embankments and field edges give a depression a straight side about as
      // long as it is wide; a natural sinkhole's rim curves (in Florida LiDAR tests, no natural one
      // ran straight for more than about 80% of its width, though a few small ones in plowed fields
      // came close).
      let straightRunM = 0;
      if (ring.length >= 8) {
        const n = ring.length, tol = 1.2 / res;
        // split the closed ring at two far-apart points, then simplify each half
        let far = 0, fd = -1;
        for (let k = 0; k < n; k++) { const d = Math.hypot(ring[k][0] - ring[0][0], ring[k][1] - ring[0][1]); if (d > fd) { fd = d; far = k; } }
        const longestEdge = (from, to) => {   // ring indices from..to (to > from, may run past n)
          const P = (k) => ring[k % n], st = [[from, to]]; let best = 0;
          while (st.length) {
            const [u, v] = st.pop();
            const [ax, ay] = P(u), [bx, by] = P(v), L = Math.hypot(bx - ax, by - ay);
            let dm = 0, ix = -1;
            if (L > 0) for (let k = u + 1; k < v; k++) { const [qx, qy] = P(k); const d = Math.abs((qx - ax) * (by - ay) - (qy - ay) * (bx - ax)) / L; if (d > dm) { dm = d; ix = k; } }
            else if (v - u > 1) { dm = Infinity; ix = (u + v) >> 1; }
            if (dm > tol) st.push([u, ix], [ix, v]); else if (L > best) best = L;
          }
          return best;
        };
        straightRunM = Math.max(longestEdge(0, far), longestEdge(far, n)) * res;
      }
      // flat bottom: a good share of it within 10 cm of one level near its lowest point - typical of
      // water, which LiDAR flattens. (That level is the 5th-percentile height, so a single stray low
      // pixel can't stand in for the bottom.)
      let flatBottom = false;
      if (area > 150) {
        const els = new Float32Array(body.length);
        for (let k = 0; k < els.length; k++) els[k] = dem[body[k]];
        els.sort();
        const base = els[Math.floor(els.length * 0.05)];
        let flat = 0; for (let k = 0; k < els.length; k++) if (Math.abs(els[k] - base) < 0.1) flat++;
        flatBottom = flat / els.length > 0.3;
      }
      keep.push({
        x: m.deepest % W, y: (m.deepest / W) | 0, cx: mx, cy: my,
        depthM: m.maxDepth, areaM2: area, diamM: diam, volumeM3: m.volume * cellArea,
        elong, flatBottom, spillM: m.spill, outline: simplify(ring),
        circularity, straightRunM, narrow, trimmedM2: (r.cells - m.cells) * cellArea,
      });
    }
    keep.sort((a, b) => b.depthM - a.depthM);
    return { found: keep, regionsTotal: regions.length, pitsTotal: pits.length };
  }

  let workerUrl = null;
  function runAnalysis(dem, W, H, res, opts) {
    return new Promise((resolve, reject) => {
      let worker = null;
      try {
        if (!workerUrl) {
          const src = `${analyze.toString()}\nself.onmessage = (e) => { const d = e.data; try { const r = analyze(d.dem, d.W, d.H, d.res, d.opts); self.postMessage(r); } catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };`;
          workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        }
        worker = new Worker(workerUrl);
      } catch (_) { worker = null; }
      if (!worker) { // no worker support (or blocked): run here, the page just pauses meanwhile
        setTimeout(() => { try { resolve(analyze(dem, W, H, res, opts)); } catch (err) { reject(err); } }, 30);
        return;
      }
      worker.onmessage = (e) => { worker.terminate(); if (e.data && e.data.error) reject(new Error(e.data.error)); else resolve(e.data); };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'scan failed')); };
      worker.postMessage({ dem, W, H, res, opts }, [dem.buffer]);
    });
  }

  // ---------- roads ----------
  // The road and railroad centre lines in an area, as line segments in lat/lng.
  async function loadRoads(b, signal) {
    const segs = [];
    await Promise.all(ROAD_LAYERS.map(async (layer) => {
      for (let offset = 0; offset < 200000; offset += 5000) {
        const q = new URLSearchParams({
          geometry: `${b.w},${b.s},${b.e},${b.n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
          outFields: 'MTFCC', returnGeometry: 'true', outSR: '4326', resultOffset: String(offset), resultRecordCount: '5000', f: 'geojson',
        });
        const resp = await fetch(`${ROADS_URL}/${layer}/query?${q}`, { signal });
        if (!resp.ok) throw new Error(`road map returned ${resp.status}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message || 'road map error');
        for (const feat of data.features || []) {
          const g = feat.geometry; if (!g) continue;
          const lines = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
          for (const ln of lines) for (let i = 1; i < ln.length; i++) segs.push([ln[i - 1][1], ln[i - 1][0], ln[i][1], ln[i][0]]);
        }
        if (!(data.exceededTransferLimit || (data.properties && data.properties.exceededTransferLimit)) || (data.features || []).length < 5000) break;
      }
    }));
    return segs;
  }
  // A lookup of road segments by 50 m squares, in metres east/north of the area's south-west corner.
  function roadIndex(segs, b) {
    const lat0 = (b.n + b.s) / 2, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574, G = 50;
    const toM = (lat, lng) => [(lng - b.w) * kx, (lat - b.s) * ky];
    const cells = new Map();
    for (const [la1, ln1, la2, ln2] of segs) {
      const [x1, y1] = toM(la1, ln1), [x2, y2] = toM(la2, ln2), sg = [x1, y1, x2, y2];
      const gx0 = Math.floor((Math.min(x1, x2) - ROAD_BUFFER_M) / G), gx1 = Math.floor((Math.max(x1, x2) + ROAD_BUFFER_M) / G);
      const gy0 = Math.floor((Math.min(y1, y2) - ROAD_BUFFER_M) / G), gy1 = Math.floor((Math.max(y1, y2) + ROAD_BUFFER_M) / G);
      if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 40000) continue;   // a stray very long segment
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const k = `${gx},${gy}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(sg);
      }
    }
    return { toM, cells, G };
  }
  // The share of an outline ([[lat, lng], ...]) that runs alongside a road: within ROAD_BUFFER_M of it
  // and roughly parallel to it (within 25 degrees), checked every 2 m. A roadside ditch, or low ground
  // the road embankment cuts off, has a whole side running along the road; a round sinkhole near a
  // road only runs parallel to it for a short stretch where its rim comes closest.
  const PARALLEL_COS = Math.cos(25 * Math.PI / 180);
  function alongRoadShare(outline, idx) {
    if (!idx || outline.length < 3) return 0;
    let near = 0, total = 0;
    const runsAlong = (x, y, ux, uy) => {
      for (const [x1, y1, x2, y2] of idx.cells.get(`${Math.floor(x / idx.G)},${Math.floor(y / idx.G)}`) || []) {
        const vx = x2 - x1, vy = y2 - y1, L2 = vx * vx + vy * vy; if (!L2) continue;
        const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / L2));
        if (Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)) > ROAD_BUFFER_M) continue;
        if (Math.abs(ux * vx + uy * vy) / Math.sqrt(L2) >= PARALLEL_COS) return true;
      }
      return false;
    };
    // the outline's direction at each point, smoothed over about 10 m so pixel steps don't count
    const pts = [];
    for (let i = 0; i < outline.length; i++) {
      const [ax, ay] = idx.toM(outline[i][0], outline[i][1]), [bx, by] = idx.toM(outline[(i + 1) % outline.length][0], outline[(i + 1) % outline.length][1]);
      const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 2));
      for (let k = 0; k < steps; k++) pts.push([ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps]);
    }
    const n = pts.length, h = Math.min(Math.max(1, Math.floor(n / 4)), 5);
    for (let i = 0; i < n; i++) {
      const [px, py] = pts[(i - h + n) % n], [qx, qy] = pts[(i + h) % n], L = Math.hypot(qx - px, qy - py);
      total++;
      if (L && runsAlong(pts[i][0], pts[i][1], (qx - px) / L, (qy - py) / L)) near++;
    }
    return total ? near / total : 0;
  }

  // ---------- helpers ----------
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function metersBetween(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const ft = (m) => Math.round(m * FT);
  function depthColor(depthM) {
    const t = Math.max(0, Math.min(1, (depthM * FT - 1) / 20)); // 1 ft -> yellow, 21+ ft -> deep red
    const r = 255, g = Math.round(220 - 200 * t), b = Math.round(60 - 60 * t);
    return [r, g, b];
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ---------- the map control ----------
  function attachControl(map, options) {
    if (typeof L === 'undefined' || !map || !window.Terrain3D || !Terrain3D.elevation) return null;
    const getCaves = (options && options.getCaves) || (() => []);
    const getMarkers = (options && options.getMarkers) || (() => []);   // what the map shows, for the 3D view
    const getBasemaps = (options && options.getBasemaps) || (() => []);
    // the results filter; kept between scans (and in this browser) so it's set the way you like it
    // (min/max in feet; Infinity = no upper limit, saved as null)
    let filter = { depthMin: 2, depthMax: Infinity, widthMin: 15, widthMax: Infinity, skipDitches: true, skipStraight: true, skipRoads: true };
    try {
      const saved = JSON.parse(localStorage.getItem('sinkscan-filter') || 'null');
      if (saved && typeof saved === 'object') {
        const num = (v, dflt) => (v === null ? Infinity : (typeof v === 'number' && isFinite(v) ? v : dflt));
        filter.depthMin = num(saved.depthMin, num(saved.depthFt, filter.depthMin));   // depthFt/widthFt: the earlier, min-only filter
        filter.depthMax = num(saved.depthMax, Infinity);
        filter.widthMin = num(saved.widthMin, num(saved.widthFt, filter.widthMin));
        filter.widthMax = num(saved.widthMax, Infinity);
        if (typeof saved.skipDitches === 'boolean') filter.skipDitches = saved.skipDitches;
        if (typeof saved.skipStraight === 'boolean') filter.skipStraight = saved.skipStraight;
        if (typeof saved.skipRoads === 'boolean') filter.skipRoads = saved.skipRoads;
      }
    } catch (_) { /* ignore */ }
    const E = Terrain3D.elevation;
    let menu = null, panel = null, cancelDraw = null, results = null, abort = null;
    const layer = L.layerGroup();
    let boxLayer = null;

    if (!document.getElementById('sinkscan-style')) {
      const st = document.createElement('style');
      st.id = 'sinkscan-style';
      st.textContent = `
        .sinkscan-control .ss-opt { display:block; width:100%; margin:0 0 6px; padding:8px 10px; border:1px solid #94a3b8; border-radius:4px;
          background:#f1f5f9; color:#0f172a; font:600 13px system-ui,sans-serif; text-align:left; cursor:pointer; }
        .sinkscan-control .ss-opt:hover, .sinkscan-control .ss-opt:focus-visible { background:#1e3a5f; border-color:#1e3a5f; color:#fff; }
        .sinkscan-control label { display:flex; align-items:center; justify-content:space-between; gap:6px; margin:4px 0; font-size:12px; color:#0f172a; }
        .sinkscan-control input[type=number] { width:58px; padding:2px 4px; }
        .sinkscan-panel { position:absolute; left:10px; bottom:28px; z-index:1000; width:300px; max-width:calc(100% - 20px); max-height:55%;
          display:flex; flex-direction:column; background:#fff; color:#0f172a; border-radius:8px; box-shadow:0 2px 12px rgba(0,0,0,.35); font:13px system-ui,sans-serif; }
        .sinkscan-panel .ss-head { display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid #e2e8f0; font-weight:700; }
        .sinkscan-panel .ss-body { overflow:auto; padding:6px 10px; }
        .sinkscan-panel.ss-minimized .ss-body { display:none; }
        .sinkscan-panel.ss-minimized .ss-head { border-bottom:0; }
        .sinkscan-panel button.ss-min { min-width:28px; font-size:15px; line-height:1; padding:2px 6px; }
        .sinkscan-panel .ss-row { padding:5px 0; border-bottom:1px solid #f1f5f9; cursor:pointer; }
        .sinkscan-panel .ss-row:hover { background:#f8fafc; }
        .sinkscan-panel .ss-sub { font-size:11px; color:#64748b; }
        .sinkscan-panel button.ss-btn { padding:3px 8px; font:600 12px system-ui,sans-serif; border:1px solid #1e3a5f; border-radius:4px; background:#fff; color:#1e3a5f; cursor:pointer; }
        .sinkscan-panel button.ss-btn:hover { background:#1e3a5f; color:#fff; }
        .sinkscan-panel .ss-dual { position:relative; height:22px; margin:2px 4px 0; }
        .sinkscan-panel .ss-dual .ss-track { position:absolute; left:0; right:0; top:9px; height:4px; border-radius:2px; background:#cbd5e1; }
        .sinkscan-panel .ss-dual .ss-sel { position:absolute; top:9px; height:4px; border-radius:2px; background:#2563eb; }
        .sinkscan-panel .ss-dual input[type=range] { position:absolute; left:-4px; width:calc(100% + 8px); top:0; height:22px; margin:0; background:none;
          -webkit-appearance:none; appearance:none; pointer-events:none; }
        .sinkscan-panel .ss-dual input[type=range]::-webkit-slider-runnable-track { background:none; }
        .sinkscan-panel .ss-dual input[type=range]::-moz-range-track { background:none; }
        .sinkscan-panel .ss-dual input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; pointer-events:auto; width:18px; height:18px;
          border-radius:50%; background:#fff; border:2px solid #2563eb; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,.3); }
        .sinkscan-panel .ss-dual input[type=range]::-moz-range-thumb { pointer-events:auto; width:14px; height:14px; border-radius:50%;
          background:#fff; border:2px solid #2563eb; cursor:pointer; }
        .sinkscan-panel .ss-progress { height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden; margin:4px 0 6px; }
        .sinkscan-panel .ss-progress > div { height:100%; background:#7c3aed; width:0; transition:width .3s; }`;
      document.head.appendChild(st);
    }

    const Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const wrap = L.DomUtil.create('div', 'leaflet-bar leaflet-control sinkscan-control');
        wrap.style.cssText = 'position:relative;background:#fff;';
        const btn = L.DomUtil.create('a', '', wrap);
        btn.href = '#'; btn.title = 'Scan for possible sinkholes'; btn.textContent = 'Sink Scan';
        btn.setAttribute('role', 'button');
        btn.style.cssText = 'font-weight:700;font-size:11px;width:auto;min-width:34px;padding:0 8px;white-space:nowrap;height:34px;line-height:34px;text-align:center;color:#1e3a5f;';
        menu = L.DomUtil.create('div', '', wrap);
        menu.style.cssText = 'display:none;position:absolute;left:calc(100% + 6px);top:0;background:#fff;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.3);padding:8px;width:240px;font:13px system-ui,sans-serif;color:#0f172a;';
        menu.appendChild(el('div', 'font-weight:700;margin-bottom:6px;', 'Scan for possible sinkholes'));
        const bView = el('button', null, 'Scan the entire map view'); bView.type = 'button'; bView.className = 'ss-opt';
        const bBox = el('button', null, 'Select an area to scan'); bBox.type = 'button'; bBox.className = 'ss-opt';
        menu.appendChild(bView); menu.appendChild(bBox);
        menu.appendChild(el('div', 'font-size:11px;color:#64748b;line-height:1.35;margin-top:4px;',
          'Finds closed low spots in USGS LiDAR elevation (US only), then sets aside the ones shaped like ditches, dug basins and road embankments (checked against the US Census road map). Always scanned at 1 m detail; areas bigger than 2 × 2 km are scanned in sections and combined (up to about 10 × 10 km). You can filter the results afterwards.'));
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);
        L.DomEvent.on(btn, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          if (cancelDraw) { cancelDraw(); return; }
          menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        });
        bView.addEventListener('click', () => { hideMenu(); scan(map.getBounds()); });
        bBox.addEventListener('click', () => {
          hideMenu();
          cancelDraw = Terrain3D.drawBox(map, 'Drag on the map to draw the area to scan.', (llb, rect) => {
            cancelDraw = null;
            clearResults();
            boxLayer = rect;
            scan(llb);
          }, () => { cancelDraw = null; }, '#7c3aed');
        });
        return wrap;
      }
    });
    function hideMenu() { if (menu) menu.style.display = 'none'; }

    let outlines = null;   // depression shapes on the map (vector, so any size of area works)
    const renderer = L.canvas({ padding: 0.3 });

    function clearResults() {
      if (abort) { abort.abort(); abort = null; }
      layer.clearLayers();
      if (map.hasLayer(layer)) map.removeLayer(layer);
      if (outlines) { map.removeLayer(outlines); outlines = null; }
      if (boxLayer) { map.removeLayer(boxLayer); boxLayer = null; }
      if (panel) { panel.remove(); panel = null; }
      results = null;
    }

    function showPanel() {
      if (panel) panel.remove();
      panel = el('div'); panel.className = 'sinkscan-panel';
      L.DomEvent.disableClickPropagation(panel);
      L.DomEvent.disableScrollPropagation(panel);
      const head = el('div'); head.className = 'ss-head';
      const title = el('span', 'flex:1;cursor:pointer;', 'Sink Scan');
      // Minimize: shrinks the window to this title bar (the count stays visible, the results stay on
      // the map). A new scan always opens it full size, so nothing that needs a click is hidden.
      const min = el('button', null, '\u2013'); min.type = 'button'; min.className = 'ss-btn ss-min';
      const close = el('button', null, 'Clear'); close.type = 'button'; close.className = 'ss-btn';
      close.title = 'Stop the scan (if running) and remove its results';
      close.addEventListener('click', clearResults);
      head.appendChild(title); head.appendChild(min); head.appendChild(close);
      const body = el('div'); body.className = 'ss-body';
      panel.appendChild(head); panel.appendChild(body);
      const setMin = (on) => {
        panel.classList.toggle('ss-minimized', on);
        min.textContent = on ? '+' : '\u2013';
        min.title = on ? 'Show the results window' : 'Minimize the results window';
        min.setAttribute('aria-label', min.title);
        min.setAttribute('aria-expanded', on ? 'false' : 'true');
      };
      setMin(false);
      min.addEventListener('click', () => setMin(!panel.classList.contains('ss-minimized')));
      title.addEventListener('click', () => { if (panel.classList.contains('ss-minimized')) setMin(false); });
      map.getContainer().appendChild(panel);
      return { title, body };
    }

    const kmOf = (b) => {
      const midLat = (b.n + b.s) / 2 * Math.PI / 180;
      return { w: (b.e - b.w) * 111320 * Math.cos(midLat), h: (b.n - b.s) * 110574 };
    };

    // Splits the area into sections: each owns a "core" (the cores tile the area exactly) and is
    // scanned with OVERLAP_M of its neighbours' cores around it.
    function planSections(b) {
      const size = kmOf(b);
      if (size.w <= SECTION_M && size.h <= SECTION_M) return [{ core: b, bounds: b, i: 0, j: 0 }];
      const nx = Math.max(1, Math.ceil(size.w / CORE_M)), ny = Math.max(1, Math.ceil(size.h / CORE_M));
      const dLng = (b.e - b.w) / nx, dLat = (b.n - b.s) / ny;
      const oLng = OVERLAP_M / size.w * (b.e - b.w), oLat = OVERLAP_M / size.h * (b.n - b.s);
      const out = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const core = { w: b.w + i * dLng, e: b.w + (i + 1) * dLng, n: b.n - j * dLat, s: b.n - (j + 1) * dLat };
        out.push({ i, j, core, bounds: { w: Math.max(b.w, core.w - oLng), e: Math.min(b.e, core.e + oLng), n: Math.min(b.n, core.n + oLat), s: Math.max(b.s, core.s - oLat) } });
      }
      return out;
    }

    function scan(llb) {
      const keepBox = boxLayer; boxLayer = null;
      clearResults();
      boxLayer = keepBox;
      const b = { n: llb.getNorth(), s: llb.getSouth(), e: llb.getEast(), w: llb.getWest() };
      const size = kmOf(b), km2 = size.w * size.h / 1e6;
      const ui = showPanel();
      const dims = `${(size.w / 1000).toFixed(1)} × ${(size.h / 1000).toFixed(1)} km`;
      if (km2 > MAX_AREA_KM2) {
        ui.body.appendChild(el('div', null,
          `This area is ${dims} - too big to scan at 1 m detail in one go (the limit is about 10 × 10 km). ` +
          'Zoom in, or select a smaller area.'));
        return;
      }
      const sections = planSections(b);
      if (sections.length === 1) { runScan(b, sections, ui); return; }
      // a big scan: say what it involves first
      ui.title.textContent = 'Large area';
      ui.body.appendChild(el('div', 'margin-bottom:8px;',
        `This area is ${dims}. To keep 1 m detail it will be scanned in ${sections.length} sections and the results combined - ` +
        `about ${Math.round(sections.length * MB_PER_SECTION)} MB of elevation data, which can take several minutes. ` +
        'Results appear as each section finishes, and you can stop at any time.'));
      const go = el('button', 'margin-right:6px;', 'Start scan'); go.type = 'button'; go.className = 'ss-btn';
      const no = el('button', null, 'Cancel'); no.type = 'button'; no.className = 'ss-btn';
      go.addEventListener('click', () => { ui.body.textContent = ''; runScan(b, sections, ui); });
      no.addEventListener('click', clearResults);
      ui.body.appendChild(go); ui.body.appendChild(no);
    }

    function runScan(b, sections, ui) {
      abort = new AbortController();
      const signal = abort.signal;
      const caves = (getCaves() || []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
      const view = buildResultsView(b, ui, sections.length);
      const sectionAt = (lat, lng) => sections.find((s) => lat <= s.core.n && lat >= s.core.s && lng >= s.core.w && lng <= s.core.e) || null;
      let failed = 0, noData = 0, done = 0, noRoads = 0;

      // Downloads run one section ahead of the analysis, so the two overlap.
      const fetchSection = (s) => {
        const plan = E.planGrid(s.bounds, SECTION_BUDGET);
        // the road map for the same area, fetched alongside; a scan still works without it
        const roads = loadRoads(s.bounds, signal).then((segs) => roadIndex(segs, s.bounds), (err) => {
          if (err.name !== 'AbortError') console.error('Sinkhole scan: road map unavailable:', err);
          return null;
        });
        return E.downloadDEM(plan, signal, (d, n) => view.progress(done, `Section ${done + 1} of ${sections.length}: downloading… ${d} of ${n}`))
          .then(async (grid) => ({ grid, plan, roads: await roads }), (err) => { if (err.name === 'AbortError') throw err; return { err }; });
      };
      let next = fetchSection(sections[0]);
      (async () => {
        for (let k = 0; k < sections.length; k++) {
          const sec = sections[k];
          const got = await next;
          if (signal.aborted) return;
          if (k + 1 < sections.length) next = fetchSection(sections[k + 1]);
          if (got.err) { failed++; console.error('Sinkhole scan section failed:', got.err); done++; continue; }
          const { grid, roads } = got;
          if (!roads) noRoads++;
          let valid = 0; for (let i = 0; i < grid.data.length; i += 7) if (grid.data[i] >= E.ND) { valid++; break; }
          if (!valid) { noData++; done++; view.progress(done, null); continue; }
          view.progress(done, `Section ${k + 1} of ${sections.length}: looking for depressions…`);
          const r = await runAnalysis(grid.data, grid.w, grid.h, grid.res, SCAN_FLOOR);
          if (signal.aborted) return;
          const gb = grid.bounds, W = grid.w, H = grid.h;
          const toLL = (x, y) => [gb.n - (y + 0.5) * (gb.n - gb.s) / H, gb.w + (x + 0.5) * (gb.e - gb.w) / W];
          const add = [];
          for (const f of r.found) {
            const [lat, lng] = toLL(f.x, f.y);
            // One section per depression: the one whose own square holds its deepest point. A depression
            // too big for that section to see whole (wider than the overlap) is kept by whichever
            // section does see it whole; doubles are dropped by the combining step.
            const owner = sections.length === 1 ? sec : sectionAt(lat, lng);
            const outline = f.outline.map(([x, y]) => toLL(x, y));
            if (owner !== sec) {
              const ob = owner && owner.bounds;
              const ownerSeesAll = ob && outline.every(([la, ln]) => la < ob.n && la > ob.s && ln > ob.w && ln < ob.e);
              if (ownerSeesAll) continue;
            }
            const reach = f.diamM / 2 + 30;
            if (caves.some((c) => metersBetween({ lat, lng }, c) <= reach)) { view.skipKnown(); continue; }
            add.push(Object.assign({}, f, { lat, lng, outline, roadShare: roads ? alongRoadShare(outline, roads) : null }));
          }
          done++;
          view.add(add);
          view.progress(done, null);
        }
        abort = null;
        view.finished({ failed, noData, noRoads });
      })().catch((err) => {
        if (err.name === 'AbortError' || signal.aborted) return;
        console.error('Sinkhole scan:', err);
        view.failed(err);
      });
    }

    // The results panel and map layers; filled in as sections finish.
    function buildResultsView(b, ui, sectionCount) {
      const all = [];
      let skippedKnown = 0, timer = null, isDone = false;
      results = { all, shown: [], bounds: b };
      outlines = L.layerGroup().addTo(map);
      layer.addTo(map);

      ui.title.textContent = 'Sink Scan';
      ui.body.textContent = '';
      const statusLine = el('div', 'font-size:12px;color:#475569;');
      const bar = el('div'); bar.className = 'ss-progress'; const fill = el('div'); bar.appendChild(fill);
      const note = el('div', 'font-size:12px;color:#475569;margin-bottom:6px;');
      ui.body.appendChild(statusLine);
      if (sectionCount > 1) ui.body.appendChild(bar);
      ui.body.appendChild(note);

      // ---- the filter ----
      const fbox = el('div', 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;margin-bottom:6px;');
      // A min/max range: two handles on one track, each stepping through FILTER_STOPS.
      const fmt = (v) => (v === Infinity ? 'no limit' : `${v.toLocaleString()} ft`);
      const nearestStop = (stops, v) => { let k = 0; for (let i = 0; i < stops.length; i++) if (Math.abs(stops[i] - v) < Math.abs(stops[k] - v) || stops[i] === v) k = i; return k; };
      const rangePair = (label, minKey, maxKey, stops) => {
        const row = el('div', 'margin:4px 0 6px;');
        const head = el('div', 'display:flex;justify-content:space-between;font-size:12px;');
        const val = el('span', 'font-weight:700;');
        head.appendChild(el('span', null, label)); head.appendChild(val);
        const dual = el('div'); dual.className = 'ss-dual';
        const track = el('div'); track.className = 'ss-track';
        const sel = el('div'); sel.className = 'ss-sel';
        const mk = (k, aria) => { const r = document.createElement('input'); r.type = 'range'; r.min = 0; r.max = stops.length - 1; r.step = 1; r.value = k; r.setAttribute('aria-label', aria); return r; };
        const lo = mk(nearestStop(stops, filter[minKey]), `${label}: minimum`);
        const hi = mk(filter[maxKey] === Infinity ? stops.length - 1 : nearestStop(stops, filter[maxKey]), `${label}: maximum`);
        if (+lo.value >= +hi.value) lo.value = Math.max(0, +hi.value - 1);
        const show = () => {
          const n = stops.length - 1, a = +lo.value / n * 100, b = +hi.value / n * 100;
          sel.style.left = `${a}%`; sel.style.width = `${b - a}%`;
          val.textContent = +hi.value === n ? `${fmt(stops[+lo.value])} or more` : `${fmt(stops[+lo.value])} – ${fmt(stops[+hi.value])}`;
          // whichever handle is nearer the middle sits on top, so a handle pushed against the other can still be grabbed
          lo.style.zIndex = +lo.value > n / 2 ? 3 : 2; hi.style.zIndex = +lo.value > n / 2 ? 2 : 3;
        };
        const update = (moved) => {
          if (+lo.value >= +hi.value) { if (moved === lo) lo.value = +hi.value - 1; else hi.value = +lo.value + 1; }
          filter[minKey] = stops[+lo.value]; filter[maxKey] = stops[+hi.value];
          show(); applyFilter();
        };
        lo.addEventListener('input', () => update(lo)); hi.addEventListener('input', () => update(hi));
        dual.appendChild(track); dual.appendChild(sel); dual.appendChild(lo); dual.appendChild(hi);
        row.appendChild(head); row.appendChild(dual); fbox.appendChild(row);
        filter[minKey] = stops[+lo.value]; filter[maxKey] = stops[+hi.value];
        show();
      };
      rangePair('Depth', 'depthMin', 'depthMax', FILTER_STOPS.depth);
      rangePair('Width', 'widthMin', 'widthMax', FILTER_STOPS.width);
      // the man-made look-alikes; each hidden by default, and each can be shown again
      fbox.appendChild(el('div', 'font-size:12px;margin-top:6px;font-weight:600;', 'Hide ones that look man-made:'));
      const toggle = (key, text, tip) => {
        const lab = el('label', 'display:flex;align-items:flex-start;gap:6px;font-size:12px;margin-top:3px;cursor:pointer;');
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = !!filter[key]; box.style.marginTop = '2px';
        box.addEventListener('change', () => { filter[key] = box.checked; applyFilter(); });
        const t = el('span', null, text); t.title = tip;
        lab.appendChild(box); lab.appendChild(t); fbox.appendChild(lab);
      };
      toggle('skipDitches', 'Long and narrow (ditches)', 'Narrower than about 23 ft all the way along, or much longer than wide');
      toggle('skipStraight', 'Straight-sided (dug ponds, borrow pits, embankments)', 'A straight side nearly as long as the depression is wide - natural sinkholes have curved rims');
      toggle('skipRoads', 'Along a road or railroad (roadside ditches, road-dammed low spots)', 'At least a fifth of its edge runs alongside a road or railroad on the US Census road map (within 50 ft and parallel to it)');
      ui.body.appendChild(fbox);

      const tools = el('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;');
      const b3d = el('button', null, 'View in 3D'); b3d.type = 'button'; b3d.className = 'ss-btn';
      const bCsv = el('button', null, 'CSV'); bCsv.type = 'button'; bCsv.className = 'ss-btn'; bCsv.title = 'Download the results shown as a spreadsheet (CSV)';
      const bGeo = el('button', null, 'GeoJSON'); bGeo.type = 'button'; bGeo.className = 'ss-btn'; bGeo.title = 'Download the results shown as GeoJSON (for GIS / Google Earth tools)';
      b3d.addEventListener('click', () => open3D());
      bCsv.addEventListener('click', () => exportCsv(results.shown));
      bGeo.addEventListener('click', () => exportGeoJson(results.shown));
      tools.appendChild(b3d); tools.appendChild(bCsv); tools.appendChild(bGeo);
      ui.body.appendChild(tools);
      const list = el('div');
      ui.body.appendChild(list);

      function writeNote(extra) {
        const sz = kmOf(b);
        note.textContent = (skippedKnown ? `${skippedKnown} with a cave already in the database ${skippedKnown === 1 ? 'is' : 'are'} left out. ` : '') +
          `Scanned at 1 m detail` + (sectionCount > 1 ? ` in ${sectionCount} sections` : '') + '. ' +
          'Depressions cut off by the edge of the area aren’t counted' +
          (sz.w > SECTION_M || sz.h > SECTION_M ? `, and one more than ${OVERLAP_M * 2} m wide lying across a section line can be missed` : '') + '.' +
          (extra ? ' ' + extra : '');
      }
      writeNote();

      function applyFilter() {
        try { localStorage.setItem('sinkscan-filter', JSON.stringify(filter)); } catch (_) { /* ignore; Infinity is saved as null */ }
        results.shown = all.filter((f) => {
          const dFt = f.depthM * FT, wFt = f.diamM * FT;
          return dFt >= filter.depthMin && dFt <= filter.depthMax && wFt >= filter.widthMin && wFt <= filter.widthMax &&
            !(filter.skipDitches && isDitch(f)) && !(filter.skipStraight && hasStraightSide(f)) && !(filter.skipRoads && alongRoad(f));
        });
        const shown = results.shown;
        ui.title.textContent = `${shown.length} possible sinkhole${shown.length === 1 ? '' : 's'}` + (shown.length !== all.length ? ` (of ${all.length})` : '') + (isDone ? '' : '…');
        layer.clearLayers(); outlines.clearLayers();
        shown.slice(0, MAX_MARKERS).forEach((f) => {
          if (!f.marker) {
            f.marker = L.circleMarker([f.lat, f.lng], { radius: Math.max(5, Math.min(14, 4 + f.diamM / 15)), color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 0.9 });
            f.marker.bindPopup(() => popupFor(f));
          }
          layer.addLayer(f.marker);
        });
        shown.slice(0, MAX_OUTLINES).forEach((f) => {
          if (!f.shape) {
            const [cr, cg, cb] = depthColor(f.depthM), col = `rgb(${cr},${cg},${cb})`;
            f.shape = L.polygon(f.outline, { renderer, color: col, weight: 1, fillColor: col, fillOpacity: 0.45, interactive: false });
          }
          outlines.addLayer(f.shape);
        });
        list.textContent = '';
        [bCsv, bGeo].forEach((x) => { x.disabled = !shown.length; });
        if (!shown.length) list.appendChild(el('div', 'font-size:12px;', all.length ? 'None match these filters - try widening the depth or width range.' : (isDone ? 'No closed depressions in this area.' : 'None found yet.')));
        shown.slice(0, MAX_LISTED).forEach((f) => {
          const row = el('div'); row.className = 'ss-row';
          row.appendChild(el('div', 'font-weight:600;color:#b91c1c;', `#${f.n}  ${ft(f.depthM)} ft deep, ${ft(f.diamM)} ft across`));
          const sub = el('div', null, describe(f)); sub.className = 'ss-sub'; row.appendChild(sub);
          row.addEventListener('click', () => { map.setView([f.lat, f.lng], Math.max(map.getZoom(), 17)); f.marker.openPopup(); });
          list.appendChild(row);
        });
        if (shown.length > MAX_LISTED) list.appendChild(el('div', 'font-size:12px;color:#64748b;padding-top:4px;', `…and ${shown.length - MAX_LISTED} more on the map and in the downloads.`));
      }
      const refresh = () => { clearTimeout(timer); timer = setTimeout(applyFilter, 60); };

      // spatial index of results so far, to drop a depression two sections both reported
      const grid = new Map(), cell = 0.0002;   // ~20 m
      const keyOf = (lat, lng) => `${Math.floor(lat / cell)},${Math.floor(lng / cell)}`;
      function isDouble(f) {
        const cy = Math.floor(f.lat / cell), cx = Math.floor(f.lng / cell);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          for (const o of grid.get(`${cy + dy},${cx + dx}`) || []) {
            if (metersBetween(o, f) < Math.max(4, Math.min(o.diamM, f.diamM) / 3) && Math.abs(o.depthM - f.depthM) < 0.3) return true;
          }
        }
        return false;
      }

      return {
        add(found) {
          for (const f of found) {
            if (isDouble(f)) continue;
            const k = keyOf(f.lat, f.lng); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(f);
            all.push(f);
          }
          all.sort((p, q) => q.depthM - p.depthM);
          all.forEach((f, i) => { f.n = i + 1; });   // deepest first; final once the scan is done
          refresh();
        },
        skipKnown() { skippedKnown++; writeNote(); },
        progress(done, text) {
          fill.style.width = `${Math.round(100 * done / sectionCount)}%`;
          statusLine.textContent = text || (done < sectionCount ? `Scanned ${done} of ${sectionCount} sections…` : '');
          if (sectionCount === 1 && !text) statusLine.textContent = '';
        },
        finished({ failed, noData, noRoads }) {
          isDone = true;
          bar.remove();
          const bits = [];
          if (failed) bits.push(`${failed} section${failed === 1 ? '' : 's'} couldn’t be downloaded, so ${failed === 1 ? 'its' : 'their'} area wasn’t scanned - try again later, or select just that part.`);
          if (noData && noData === sectionCount) bits.push('No elevation data here. USGS 3DEP covers the United States only.');
          else if (noData) bits.push(`${noData} section${noData === 1 ? ' has' : 's have'} no elevation data.`);
          if (noRoads) bits.push(`The road map couldn’t be loaded for ${noRoads === sectionCount ? 'this area' : `${noRoads} section${noRoads === 1 ? '' : 's'}`}, so ones along roads there aren’t marked.`);
          statusLine.textContent = '';
          writeNote(bits.join(' '));
          applyFilter();
        },
        failed(err) {
          isDone = true;
          statusLine.textContent = 'The scan stopped: ' + err.message + '. Check your connection and try again.' + (all.length ? ' The results so far are below.' : '');
          applyFilter();
        },
      };
    }

    // The scanned area in the 3D view, with the results shown as pins (plus the caves the map is showing)
    function open3D() {
      if (!results || !Terrain3D.open) return;
      const pins = results.shown.slice(0, 250).map((f) => ({ lat: f.lat, lng: f.lng, color: '#dc2626', label: `#${f.n} · ${ft(f.depthM)} ft deep` }));
      let markers = [];
      try { markers = getMarkers() || []; } catch (_) { markers = []; }
      const b = results.bounds;
      markers = markers.filter((m) => m.lat <= b.n && m.lat >= b.s && m.lng <= b.e && m.lng >= b.w);
      const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      Terrain3D.open({ bounds: b, markers: pins.concat(markers), basemaps: getBasemaps(),
        summary: `Showing ${plural(pins.length, 'possible sinkhole', 'possible sinkholes')} (red, numbered as in the scan list) and ${plural(markers.length, 'cave', 'caves')}.` +
          (results.shown.length > pins.length ? ` Only the ${pins.length} deepest are pinned.` : '') });
    }

    function describe(f) {
      const bits = [];
      if (f.flatBottom) bits.push('flat bottom - probably holds water');
      if (isDitch(f)) bits.push('ditch-shaped');
      if (hasStraightSide(f)) bits.push('straight-sided');
      if (alongRoad(f)) bits.push('along a road');
      bits.push(`${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}`);
      return bits.join(' · ');
    }

    function popupFor(f) {
      const box = el('div', 'font:13px system-ui,sans-serif;min-width:190px;');
      box.appendChild(el('div', 'font-weight:700;margin-bottom:4px;', `Possible sinkhole #${f.n}`));
      const line = (t) => box.appendChild(el('div', null, t));
      line(`Depth: about ${ft(f.depthM)} ft below where it would overflow`);
      line(`Size: about ${ft(f.diamM)} ft across (${Math.round(f.areaM2 * FT * FT).toLocaleString()} sq ft)`);
      line(`Shape: ${f.circularity >= 0.75 ? 'round' : f.circularity >= 0.5 ? 'rounded' : 'irregular'} (roundness ${Math.round(f.circularity * 100)}%)`);
      if (f.trimmedM2 > 20) line(`A ditch or drain running off it (${Math.round(f.trimmedM2 * FT * FT).toLocaleString()} sq ft) is left out of its size`);
      if (f.flatBottom) line('Flat bottom: probably holds water (pond or lake)');
      if (isDitch(f)) line('Long and narrow: probably a ditch');
      if (hasStraightSide(f)) line(`Straight side ${ft(f.straightRunM)} ft long: probably dug, or shaped by a field edge or embankment`);
      if (alongRoad(f)) line(`Runs along a road or railroad (${Math.round(f.roadShare * 100)}% of its edge): probably a roadside ditch or low ground dammed by the road`);
      const coords = `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}`;
      const c = el('div', 'margin-top:6px;display:flex;align-items:center;gap:6px;');
      c.appendChild(el('code', 'font-size:12px;', coords));
      const copy = el('button', 'padding:2px 6px;font-size:11px;cursor:pointer;', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        (navigator.clipboard ? navigator.clipboard.writeText(coords) : Promise.reject())
          .then(() => { copy.textContent = 'Copied'; })
          .catch(() => { copy.textContent = 'Select the text to copy'; });
      });
      c.appendChild(copy); box.appendChild(c);
      box.appendChild(el('div', 'margin-top:6px;font-size:11px;color:#64748b;', 'A candidate from elevation data only - check it on the ground or on imagery, with the landowner’s permission.'));
      return box;
    }

    function rowsOf(found) {
      return found.map((f) => ({
        number: f.n, latitude: +f.lat.toFixed(6), longitude: +f.lng.toFixed(6),
        depth_ft: +(f.depthM * FT).toFixed(1), width_ft: +(f.diamM * FT).toFixed(0), area_sqft: Math.round(f.areaM2 * FT * FT),
        roundness: +f.circularity.toFixed(2), straight_side_ft: ft(f.straightRunM),
        road_edge_share: f.roadShare == null ? '' : +f.roadShare.toFixed(2),
        flat_bottom: f.flatBottom, ditch_shaped: isDitch(f), straight_sided: hasStraightSide(f), along_road: alongRoad(f),
      }));
    }
    function stamp() { return new Date().toISOString().slice(0, 10); }
    function exportCsv(found) {
      const rows = rowsOf(found), cols = Object.keys(rows[0]);
      const esc = (v) => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      download(`sinkhole-scan-${stamp()}.csv`, [cols.join(',')].concat(rows.map((r) => cols.map((k) => esc(r[k])).join(','))).join('\n'), 'text/csv');
    }
    function exportGeoJson(found) {
      const fc = { type: 'FeatureCollection', features: rowsOf(found).map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] }, properties: p })) };
      download(`sinkhole-scan-${stamp()}.geojson`, JSON.stringify(fc, null, 1), 'application/geo+json');
    }

    const control = new Control();
    map.addControl(control);
    map.on('click', hideMenu);
    return { control, clear: clearResults, results: () => results };
  }

  window.SinkholeScan = { attachControl, analyze, SCAN_FLOOR, isDitch, hasStraightSide, alongRoad, roadIndex, alongRoadShare };
})();
