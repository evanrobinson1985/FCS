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
 *   3. group the filled cells into depressions and keep the ones deep and wide
 *      enough to matter, describing each (depth, size, shape, flat bottom =
 *      likely water, known cave nearby).
 * Steps 2-3 run in a background worker, so the page stays responsive. Nothing
 * is sent to this site's server.
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
      const r = { id: n, cells: 0, maxDepth: 0, deepest: s, volume: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, spill: filled[s], cellsList: [] };
      while (sp) {
        const c = stack[--sp], cx = c % W, cy = (c / W) | 0, d = filled[c] - dem[c];
        r.cells++; r.volume += d; r.sx += cx; r.sy += cy; r.sxx += cx * cx; r.syy += cy * cy; r.sxy += cx * cy;
        if (d > r.maxDepth) { r.maxDepth = d; r.deepest = c; }
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

    // The outline of one depression, in cell coordinates: trace round the edge of its cells
    // (Moore neighbour tracing), then drop points that don't change the shape (Douglas-Peucker).
    function outlineOf(cells) {
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
      const keepPt = new Uint8Array(pts.length); keepPt[0] = 1; keepPt[pts.length - 1] = 1;
      const st = [[0, pts.length - 1]];
      while (st.length) {
        const [a, b] = st.pop(); if (b - a < 2) continue;
        const [ax, ay] = pts[a], [bx, by] = pts[b], len = Math.hypot(bx - ax, by - ay) || 1;
        let dm = 0, ix = -1;
        for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * (by - ay) - (pts[i][1] - ay) * (bx - ax)) / len; if (d > dm) { dm = d; ix = i; } }
        if (dm > 0.75) { keepPt[ix] = 1; st.push([a, ix], [ix, b]); }
      }
      const out = [];
      for (let i = 0; i < pts.length; i++) if (keepPt[i]) out.push([pts[i][0] + x0 - 1, pts[i][1] + y0 - 1]);
      return out;
    }

    const keep = [], cellArea = res * res;
    for (const r of regions) {
      const area = r.cells * cellArea, diam = 2 * Math.sqrt(area / Math.PI);
      if (r.maxDepth < minDepth || diam < minDiam) continue;
      // shape: how long and narrow (ratio of the two axes of its spread)
      const mx = r.sx / r.cells, my = r.sy / r.cells;
      const vxx = r.sxx / r.cells - mx * mx, vyy = r.syy / r.cells - my * my, vxy = r.sxy / r.cells - mx * my;
      const tr = vxx + vyy, det = vxx * vyy - vxy * vxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
      const elong = Math.sqrt(l1 / l2);
      if (maxElong && elong > maxElong) continue;
      // flat bottom: a good share of it within 10 cm of one level near its lowest point - typical of
      // water, which LiDAR flattens. (That level is the 5th-percentile height, so a single stray low
      // pixel can't stand in for the bottom.)
      let flatBottom = false;
      if (r.cells * cellArea > 150) {
        const els = new Float32Array(r.cellsList.length);
        for (let k = 0; k < els.length; k++) els[k] = dem[r.cellsList[k]];
        els.sort();
        const base = els[Math.floor(els.length * 0.05)];
        let flat = 0; for (let k = 0; k < els.length; k++) if (Math.abs(els[k] - base) < 0.1) flat++;
        flatBottom = flat / els.length > 0.3;
      }
      keep.push({
        x: r.deepest % W, y: (r.deepest / W) | 0, cx: mx, cy: my,
        depthM: r.maxDepth, areaM2: area, diamM: diam, volumeM3: r.volume * cellArea,
        elong, flatBottom, spillM: r.spill, outline: outlineOf(r.cellsList),
      });
    }
    keep.sort((a, b) => b.depthM - a.depthM);
    return { found: keep, regionsTotal: regions.length };
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
    let filter = { depthMin: 2, depthMax: Infinity, widthMin: 15, widthMax: Infinity, skipDitches: true };
    try {
      const saved = JSON.parse(localStorage.getItem('sinkscan-filter') || 'null');
      if (saved && typeof saved === 'object') {
        const num = (v, dflt) => (v === null ? Infinity : (typeof v === 'number' && isFinite(v) ? v : dflt));
        filter.depthMin = num(saved.depthMin, num(saved.depthFt, filter.depthMin));   // depthFt/widthFt: the earlier, min-only filter
        filter.depthMax = num(saved.depthMax, Infinity);
        filter.widthMin = num(saved.widthMin, num(saved.widthFt, filter.widthMin));
        filter.widthMax = num(saved.widthMax, Infinity);
        if (typeof saved.skipDitches === 'boolean') filter.skipDitches = saved.skipDitches;
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
          'Finds closed low spots in USGS LiDAR elevation (US only) - mostly sinkholes here, but also ponds, pits and spots where a road blocks drainage. Always scanned at 1 m detail; areas bigger than 2 × 2 km are scanned in sections and combined (up to about 10 × 10 km). You can filter the results by depth and width afterwards.'));
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
      let failed = 0, noData = 0, done = 0;

      // Downloads run one section ahead of the analysis, so the two overlap.
      const fetchSection = (s) => {
        const plan = E.planGrid(s.bounds, SECTION_BUDGET);
        return E.downloadDEM(plan, signal, (d, n) => view.progress(done, `Section ${done + 1} of ${sections.length}: downloading… ${d} of ${n}`))
          .then((grid) => ({ grid, plan }), (err) => { if (err.name === 'AbortError') throw err; return { err }; });
      };
      let next = fetchSection(sections[0]);
      (async () => {
        for (let k = 0; k < sections.length; k++) {
          const sec = sections[k];
          const got = await next;
          if (signal.aborted) return;
          if (k + 1 < sections.length) next = fetchSection(sections[k + 1]);
          if (got.err) { failed++; console.error('Sinkhole scan section failed:', got.err); done++; continue; }
          const { grid } = got;
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
            add.push(Object.assign({}, f, { lat, lng, outline }));
          }
          done++;
          view.add(add);
          view.progress(done, null);
        }
        abort = null;
        view.finished({ failed, noData });
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
      const dl = el('label', 'display:flex;align-items:center;gap:6px;font-size:12px;margin-top:4px;cursor:pointer;');
      const ditch = document.createElement('input'); ditch.type = 'checkbox'; ditch.checked = !!filter.skipDitches;
      ditch.addEventListener('change', () => { filter.skipDitches = ditch.checked; applyFilter(); });
      dl.appendChild(ditch); dl.appendChild(document.createTextNode('Hide long, narrow ones (ditches)'));
      fbox.appendChild(dl);
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
            !(filter.skipDitches && f.elong > 4);
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
        finished({ failed, noData }) {
          isDone = true;
          bar.remove();
          const bits = [];
          if (failed) bits.push(`${failed} section${failed === 1 ? '' : 's'} couldn’t be downloaded, so ${failed === 1 ? 'its' : 'their'} area wasn’t scanned - try again later, or select just that part.`);
          if (noData && noData === sectionCount) bits.push('No elevation data here. USGS 3DEP covers the United States only.');
          else if (noData) bits.push(`${noData} section${noData === 1 ? ' has' : 's have'} no elevation data.`);
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
      if (f.elong > 2.5) bits.push('long and narrow');
      bits.push(`${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}`);
      return bits.join(' · ');
    }

    function popupFor(f) {
      const box = el('div', 'font:13px system-ui,sans-serif;min-width:190px;');
      box.appendChild(el('div', 'font-weight:700;margin-bottom:4px;', `Possible sinkhole #${f.n}`));
      const line = (t) => box.appendChild(el('div', null, t));
      line(`Depth: about ${ft(f.depthM)} ft below where it would overflow`);
      line(`Size: about ${ft(f.diamM)} ft across (${Math.round(f.areaM2 * FT * FT).toLocaleString()} sq ft)`);
      if (f.flatBottom) line('Flat bottom: probably holds water (pond or lake)');
      if (f.elong > 2.5) line('Long and narrow: could be a ditch or drainage feature');
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
        flat_bottom: f.flatBottom, long_narrow: f.elong > 2.5,
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

  window.SinkholeScan = { attachControl, analyze };
})();
