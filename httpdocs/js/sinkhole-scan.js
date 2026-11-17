/*
 * Sinkhole scan for the Interactive Map.
 *
 * Adds a "Scan" button to the map. Anyone logged in can scan the whole map
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

  const CELL_BUDGET = 4e6; // elevation cells per scan: about 2 x 2 km at 1 m detail
  const MAX_RES = 6;       // coarser than this (m per cell), sinkholes stop being visible
  const FT = 3.28084;
  const MAX_LISTED = 300;
  // A scan keeps every depression at least this deep and wide; the filters on the results then
  // narrow what's shown, so they can be changed (either way) without scanning again.
  const SCAN_FLOOR = { minDepthM: 1 / 3.28084, minDiamM: 5 / 3.28084, maxElong: 0 };
  const FILTER_LIMITS = { depth: [1, 40], width: [5, 300] };
  const MAX_MARKERS = 2000;

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

    const keep = [], cellArea = res * res;
    const shown = new Float32Array(N); // filled depth of every kept cell, for drawing
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
      for (const c of r.cellsList) shown[c] = filled[c] - dem[c];
      keep.push({
        x: r.deepest % W, y: (r.deepest / W) | 0, cx: mx, cy: my,
        depthM: r.maxDepth, areaM2: area, diamM: diam, volumeM3: r.volume * cellArea,
        elong, flatBottom, spillM: r.spill, cellsList: r.cellsList,
      });
    }
    keep.sort((a, b) => b.depthM - a.depthM);
    // regionOf[cell] = 1 + index in `found` of the depression it belongs to (0 = none), so the map
    // can redraw just the depressions a filter leaves showing
    const regionOf = new Int32Array(N);
    keep.forEach((k, i) => { for (const c of k.cellsList) regionOf[c] = i + 1; delete k.cellsList; });
    return { found: keep, shown, regionOf, regionsTotal: regions.length };
  }

  let workerUrl = null;
  function runAnalysis(dem, W, H, res, opts) {
    return new Promise((resolve, reject) => {
      let worker = null;
      try {
        if (!workerUrl) {
          const src = `${analyze.toString()}\nself.onmessage = (e) => { const d = e.data; try { const r = analyze(d.dem, d.W, d.H, d.res, d.opts); self.postMessage(r, [r.shown.buffer, r.regionOf.buffer]); } catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };`;
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
    let filter = { depthFt: 2, widthFt: 15, skipDitches: true };
    try { const saved = JSON.parse(localStorage.getItem('sinkscan-filter') || 'null'); if (saved && typeof saved === 'object') filter = Object.assign(filter, saved); } catch (_) { /* ignore */ }
    const E = Terrain3D.elevation;
    let menu = null, panel = null, cancelDraw = null, results = null, abort = null;
    const layer = L.layerGroup();
    let overlay = null, boxLayer = null;

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
        .sinkscan-panel .ss-row { padding:5px 0; border-bottom:1px solid #f1f5f9; cursor:pointer; }
        .sinkscan-panel .ss-row:hover { background:#f8fafc; }
        .sinkscan-panel .ss-sub { font-size:11px; color:#64748b; }
        .sinkscan-panel button.ss-btn { padding:3px 8px; font:600 12px system-ui,sans-serif; border:1px solid #1e3a5f; border-radius:4px; background:#fff; color:#1e3a5f; cursor:pointer; }
        .sinkscan-panel button.ss-btn:hover { background:#1e3a5f; color:#fff; }
        .sinkscan-overlay { image-rendering: pixelated; }`;
      document.head.appendChild(st);
    }

    const Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const wrap = L.DomUtil.create('div', 'leaflet-bar leaflet-control sinkscan-control');
        wrap.style.cssText = 'position:relative;background:#fff;';
        const btn = L.DomUtil.create('a', '', wrap);
        btn.href = '#'; btn.title = 'Scan for possible sinkholes'; btn.textContent = 'Scan';
        btn.setAttribute('role', 'button');
        btn.style.cssText = 'font-weight:700;font-size:11px;width:34px;height:34px;line-height:34px;text-align:center;color:#1e3a5f;';
        menu = L.DomUtil.create('div', '', wrap);
        menu.style.cssText = 'display:none;position:absolute;left:40px;top:0;background:#fff;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.3);padding:8px;width:240px;font:13px system-ui,sans-serif;color:#0f172a;';
        menu.appendChild(el('div', 'font-weight:700;margin-bottom:6px;', 'Scan for possible sinkholes'));
        const bView = el('button', null, 'Scan the entire map view'); bView.type = 'button'; bView.className = 'ss-opt';
        const bBox = el('button', null, 'Select an area to scan'); bBox.type = 'button'; bBox.className = 'ss-opt';
        menu.appendChild(bView); menu.appendChild(bBox);
        menu.appendChild(el('div', 'font-size:11px;color:#64748b;line-height:1.35;margin-top:4px;',
          'Finds closed low spots in USGS LiDAR elevation (US only) - mostly sinkholes here, but also ponds, pits and spots where a road blocks drainage. Areas up to about 2 × 2 km are scanned at 1 m detail. You can filter the results by depth and width afterwards.'));
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

    function clearResults() {
      if (abort) { abort.abort(); abort = null; }
      layer.clearLayers();
      if (map.hasLayer(layer)) map.removeLayer(layer);
      if (overlay) { map.removeLayer(overlay); overlay = null; }
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
      const title = el('span', 'flex:1;', 'Sinkhole scan');
      const close = el('button', null, 'Clear'); close.type = 'button'; close.className = 'ss-btn';
      close.addEventListener('click', clearResults);
      head.appendChild(title); head.appendChild(close);
      const body = el('div'); body.className = 'ss-body';
      panel.appendChild(head); panel.appendChild(body);
      map.getContainer().appendChild(panel);
      return { title, body };
    }

    function scan(llb) {
      const opts = SCAN_FLOOR;
      clearResults();
      const b = { n: llb.getNorth(), s: llb.getSouth(), e: llb.getEast(), w: llb.getWest() };
      const plan = E.planGrid(b, CELL_BUDGET);
      const ui = showPanel();
      if (plan.res > MAX_RES) {
        ui.body.appendChild(el('div', null,
          `This area is ${(plan.widthM / 1000).toFixed(1)} × ${(plan.heightM / 1000).toFixed(1)} km - too big to see sinkholes in. ` +
          'Zoom in, or select a smaller area (up to about 12 × 12 km).'));
        return;
      }
      abort = new AbortController();
      const status = el('div', null, 'Downloading USGS elevation data…');
      ui.body.appendChild(status);
      const signal = abort.signal;
      E.downloadDEM(plan, signal, (d, n) => { status.textContent = `Downloading USGS elevation data… ${d} of ${n}`; })
        .then((grid) => {
          if (signal.aborted) return null;
          let valid = 0; for (let i = 0; i < grid.data.length; i++) if (grid.data[i] >= E.ND) valid++;
          if (!valid) { status.textContent = 'No elevation data here. USGS 3DEP covers the United States only.'; return null; }
          status.textContent = 'Looking for depressions…';
          return runAnalysis(grid.data, grid.w, grid.h, grid.res, opts).then((r) => ({ r, grid }));
        })
        .then((out) => {
          if (!out || signal.aborted) return;
          abort = null;
          showResults(out.r, out.grid, plan, opts, ui);
        })
        .catch((err) => {
          if (err.name === 'AbortError' || signal.aborted) return;
          console.error('Sinkhole scan:', err);
          status.textContent = 'The scan failed: ' + err.message + '. Check your connection and try again.';
        });
    }

    function showResults(r, grid, plan, opts, ui) {
      const b = grid.bounds, W = grid.w, H = grid.h;
      const cellLL = (x, y) => L.latLng(b.n - (y + 0.5) * (b.n - b.s) / H, b.w + (x + 0.5) * (b.e - b.w) / W);
      // Depressions that already have a cave in the database are left out: the point is to find
      // new ones. "Has a cave" = a recorded cave (or entrance) within the depression's own radius
      // plus 100 ft - cave coordinates are often a little off, and an entrance can sit on the slope.
      const caves = (getCaves() || []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
      const all = [];
      let skippedKnown = 0;
      r.found.forEach((f, i) => {
        const at = cellLL(f.x, f.y), reach = f.diamM / 2 + 30;
        if (caves.some((c) => metersBetween(at, c) <= reach)) { skippedKnown++; return; }
        all.push(Object.assign({ region: i + 1, lat: at.lat, lng: at.lng }, f));
      });
      all.forEach((f, i) => { f.n = i + 1; });   // numbered once, so a result keeps its number whatever the filter
      results = { all, shown: [], plan, bounds: b, skippedKnown };

      ui.title.textContent = 'Sinkhole scan';
      ui.body.textContent = '';
      const detail = plan.res <= 1.05 ? '1 m' : `${plan.res.toFixed(1)} m`;
      ui.body.appendChild(el('div', 'font-size:12px;color:#475569;margin-bottom:6px;',
        (skippedKnown ? `${skippedKnown} with a cave already in the database ${skippedKnown === 1 ? 'is' : 'are'} left out. ` : '') +
        `Scanned at ${detail} detail` + (plan.res > 2 ? ' - smaller sinkholes may be missed; zoom in or select a smaller area for more detail.' : '.') +
        ' Depressions cut off by the edge of the area aren’t counted.'));

      // ---- the filter ----
      const fbox = el('div', 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;margin-bottom:6px;');
      const slider = (label, key, [min, max], step) => {
        const row = el('div', 'margin:2px 0;');
        const head = el('div', 'display:flex;justify-content:space-between;font-size:12px;');
        const val = el('span', 'font-weight:700;');
        head.appendChild(el('span', null, label)); head.appendChild(val);
        const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step;
        inp.value = Math.min(max, Math.max(min, filter[key])); inp.style.cssText = 'width:100%;margin:2px 0 0;';
        const show = () => { val.textContent = `${inp.value} ft`; };
        inp.addEventListener('input', () => { filter[key] = +inp.value; show(); applyFilter(); });
        show(); row.appendChild(head); row.appendChild(inp); fbox.appendChild(row);
      };
      slider('Deeper than', 'depthFt', FILTER_LIMITS.depth, 1);
      slider('Wider than', 'widthFt', FILTER_LIMITS.width, 5);
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

      // ---- draw what the filter leaves ----
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      let redrawTimer = null;
      function drawOverlay() {
        const on = new Uint8Array(r.found.length + 1);
        results.shown.forEach((f) => { on[f.region] = 1; });
        const img = ctx.createImageData(W, H), d = img.data;
        for (let i = 0; i < W * H; i++) {
          const k = r.regionOf[i]; if (!k || !on[k]) continue;
          const [cr, cg, cb] = depthColor(r.shown[i]);
          d[i * 4] = cr; d[i * 4 + 1] = cg; d[i * 4 + 2] = cb; d[i * 4 + 3] = 150;
        }
        ctx.putImageData(img, 0, 0);
        const url = cv.toDataURL('image/png');
        if (overlay) overlay.setUrl(url);
        else overlay = L.imageOverlay(url, [[b.s, b.w], [b.n, b.e]], { opacity: 0.85, interactive: false, className: 'sinkscan-overlay' }).addTo(map);
      }
      function applyFilter() {
        try { localStorage.setItem('sinkscan-filter', JSON.stringify(filter)); } catch (_) { /* ignore */ }
        results.shown = all.filter((f) => f.depthM * FT >= filter.depthFt && f.diamM * FT >= filter.widthFt && !(filter.skipDitches && f.elong > 4));
        const shown = results.shown;
        ui.title.textContent = `${shown.length} possible sinkhole${shown.length === 1 ? '' : 's'}` + (shown.length !== all.length ? ` (of ${all.length})` : '');
        layer.clearLayers();
        shown.slice(0, MAX_MARKERS).forEach((f) => {
          if (!f.marker) {
            f.marker = L.circleMarker([f.lat, f.lng], { radius: Math.max(5, Math.min(14, 4 + f.diamM / 15)), color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 0.9 });
            f.marker.bindPopup(() => popupFor(f));
          }
          layer.addLayer(f.marker);
        });
        if (!map.hasLayer(layer)) layer.addTo(map);
        list.textContent = '';
        [bCsv, bGeo].forEach((x) => { x.disabled = !shown.length; });
        if (!shown.length) list.appendChild(el('div', 'font-size:12px;', all.length ? 'None match these filters - try a lower depth or width.' : 'No closed depressions in this area.'));
        shown.slice(0, MAX_LISTED).forEach((f) => {
          const row = el('div'); row.className = 'ss-row';
          row.appendChild(el('div', 'font-weight:600;color:#b91c1c;', `#${f.n}  ${ft(f.depthM)} ft deep, ${ft(f.diamM)} ft across`));
          const sub = el('div', null, describe(f)); sub.className = 'ss-sub'; row.appendChild(sub);
          row.addEventListener('click', () => { map.setView([f.lat, f.lng], Math.max(map.getZoom(), 17)); f.marker.openPopup(); });
          list.appendChild(row);
        });
        if (shown.length > MAX_LISTED) list.appendChild(el('div', 'font-size:12px;color:#64748b;padding-top:4px;', `…and ${shown.length - MAX_LISTED} more on the map and in the downloads.`));
        clearTimeout(redrawTimer); redrawTimer = setTimeout(drawOverlay, 120);   // the shapes: redrawn once the slider settles
      }
      applyFilter();
      drawOverlay();
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
