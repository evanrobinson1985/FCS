/*
 * 3D terrain viewer for the Interactive Map.
 *
 * Adds a "3D" button to a Leaflet map. The user chooses to view the whole
 * map view, or to drag a box on the map. The viewer then downloads
 * bare-earth elevation for that area from the USGS 3DEP elevation service,
 * and shows it as a lit 3D surface (raw WebGL 1, no 3D library) that you
 * can fly through, with the caves currently on the map shown as coloured
 * pins.
 *
 * Needs the geotiff.js browser build (global `GeoTIFF`), which portal.html
 * already loads.
 *
 * Usage:
 *   Terrain3D.attachControl(map, {
 *     getMarkers: () => [{ lat, lng, color: '#rrggbb', label: 'Name' }, ...],
 *     // optional: map layers the user can drape over the terrain
 *     getBasemaps: () => [{ label, url: 'https://…/{z}/{y}/{x}', options: { maxNativeZoom }, active }]
 *   });
 *   // or directly:
 *   Terrain3D.open({ bounds: { n, s, e, w }, markers: [...] });
 */
(function () {
  'use strict';

  const ELEVATION_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
  // Cell count, not box size, is what's capped - a small box always gets
  // full 1 m detail (MIN_RES below), a bigger one gets coarser per-cell
  // spacing to stay inside this budget (see planGrid). Raising this gives
  // every box size finer detail at the cost of a bigger download and more
  // browser memory for the raw elevation array (~36 MB as floats at 9e6,
  // up from ~16 MB at the old 4e6) - see the matching maxGrid bump below,
  // which is what actually lets the extra detail reach the rendered mesh
  // instead of just being resampled back down.
  const CELL_BUDGET = 9e6;   // elevation cells downloaded per view
  const MIN_RES = 1;         // 3DEP's best is 1 m LiDAR; finer is pointless
  const TILE = 1000;         // pixels per side of each download request
  const PARALLEL = 4;        // requests in flight at once
  const MAX_LABELS = 300;    // cave names drawn as HTML labels
  const NODATA = -9999, ND = -100; // values below ND are NoData

  let active = null; // the open viewer, if any

  // ---------- small matrix helpers (column-major, like WebGL) ----------
  function mat4Perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function mat4LookAt(eye, target, up) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let len = Math.hypot(zx, zy, zz); zx /= len; zy /= len; zz /= len;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz); xx /= len; xy /= len; xz /= len;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1]);
  }
  function mat4Mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function createShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.error('3D view shader:', gl.getShaderInfoLog(sh)); gl.deleteShader(sh); return null; }
    return sh;
  }
  function hexRGB(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return [0.86, 0.15, 0.15];
    const v = parseInt(m[1], 16);
    return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
  }

  // ---------- elevation download ----------
  // Picks a grid for the box: 1 m cells when the area fits the cell budget,
  // otherwise the finest spacing that does.
  function planGrid(b) {
    const midLat = (b.n + b.s) / 2 * Math.PI / 180;
    const widthM = (b.e - b.w) * 111320 * Math.cos(midLat), heightM = (b.n - b.s) * 110574;
    const res = Math.max(MIN_RES, Math.sqrt(widthM * heightM / CELL_BUDGET));
    const W = Math.max(16, Math.round(widthM / res)), H = Math.max(16, Math.round(heightM / res));
    return { bounds: b, W, H, res: Math.sqrt((widthM / W) * (heightM / H)), widthM, heightM };
  }

  // fetch() has no built-in timeout, and a stalled connection (a firewall,
  // router, or ISP that drops a request without ever sending back a reset)
  // just hangs forever rather than rejecting - which, with no retry ever
  // kicking in, means the whole box's download never finishes and the "N
  // of M" progress line sits frozen with no error. This bounds every
  // attempt so a stall surfaces as a failure the retry loop below can act
  // on, same as a real network error would. Named 'TimeoutError' (not
  // 'AbortError') so it still goes through the retry/backoff path instead
  // of being treated like the user's own cancel signal.
  function fetchWithTimeout(url, signal, timeoutMs) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(new DOMException('Elevation tile request timed out', 'TimeoutError')), timeoutMs);
    return fetch(url, { signal: ctrl.signal }).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
  }

  async function fetchTile(plan, job, out, signal) {
    const b = plan.bounds, dLon = (b.e - b.w) / plan.W, dLat = (b.n - b.s) / plan.H;
    const w = b.w + job.c0 * dLon, e = b.w + (job.c0 + job.w) * dLon;
    const n = b.n - job.r0 * dLat, s = b.n - (job.r0 + job.h) * dLat;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const url = `${ELEVATION_URL}?bbox=${w},${s},${e},${n}&bboxSR=4326&size=${job.w},${job.h}&imageSR=4326` +
        `&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation` +
        `${attempt < 2 ? '&compression=LZ77' : ''}&adjustAspectRatio=false&f=image`;
      try {
        const resp = await fetchWithTimeout(url, signal, 20000);
        if (!resp.ok) throw new Error(`elevation server returned ${resp.status}`);
        const tiff = await GeoTIFF.fromArrayBuffer(await resp.arrayBuffer());
        const image = await tiff.getImage();
        if (image.getWidth() !== job.w || image.getHeight() !== job.h) throw new Error('elevation tile came back the wrong size');
        const data = (await image.readRasters())[0];
        for (let r = 0; r < job.h; r++) {
          const o = (job.r0 + r) * plan.W + job.c0;
          for (let c = 0; c < job.w; c++) {
            const v = data[r * job.w + c];
            out[o + c] = (Number.isFinite(v) && v > -1000) ? v : NODATA;
          }
        }
        return;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastErr = err;
        await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async function downloadDEM(plan, signal, onProgress) {
    const out = new Float32Array(plan.W * plan.H).fill(NODATA);
    const jobs = [];
    for (let r0 = 0; r0 < plan.H; r0 += TILE) for (let c0 = 0; c0 < plan.W; c0 += TILE)
      jobs.push({ r0, c0, w: Math.min(TILE, plan.W - c0), h: Math.min(TILE, plan.H - r0) });
    let next = 0, done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await fetchTile(plan, job, out, signal);
        onProgress(++done, jobs.length);
      }
    };
    onProgress(0, jobs.length);
    await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
    return { data: out, w: plan.W, h: plan.H, bounds: plan.bounds, res: plan.res };
  }

  // ---------- basemap imagery draped over the terrain ----------
  // Loads the basemap's web-map tiles covering the box and draws them into
  // an iw x ih canvas on the same lat/lon grid as the elevation. Each tile
  // is stretched to its own lat/lon rectangle, which matches Web Mercator
  // closely at the zoom levels used here.
  function tileUrl(bm, x, y, z) {
    const o = bm.options || {};
    let subs = o.subdomains || 'abc';
    if (typeof subs === 'string') subs = subs.split('');
    const data = Object.assign({}, o, { s: subs[Math.abs(x + y) % subs.length] || '', x, y: o.tms ? (1 << z) - 1 - y : y, z, r: '' });
    return bm.url.replace(/\{ *([\w_ -]+) *\}/g, (m, key) => (data[key] != null ? data[key] : ''));
  }
  async function loadImagery(bm, b, iw, ih, signal, onProgress) {
    const midLat = (b.n + b.s) / 2;
    const mppWanted = (b.e - b.w) * 111320 * Math.cos(midLat * Math.PI / 180) / iw;
    const o = bm.options || {};
    const zMax = Math.min(o.maxNativeZoom != null ? o.maxNativeZoom : (o.maxZoom != null ? o.maxZoom : 19), 19);
    const lon2x = (lon, z) => (lon + 180) / 360 * (1 << z);
    const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z); };
    const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (1 << z); return Math.atan(Math.sinh(n)) * 180 / Math.PI; };
    let z = Math.max(1, Math.min(zMax, Math.round(Math.log2(156543.03 * Math.cos(midLat * Math.PI / 180) / Math.max(0.1, mppWanted)))));
    let x0, x1, y0, y1;
    for (;;) {
      x0 = Math.floor(lon2x(b.w, z)); x1 = Math.floor(lon2x(b.e, z));
      y0 = Math.floor(lat2y(b.n, z)); y1 = Math.floor(lat2y(b.s, z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 400 || z <= 1) break;
      z--;
    }
    const canvas = document.createElement('canvas');
    canvas.width = iw; canvas.height = ih;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#5b5f55'; ctx.fillRect(0, 0, iw, ih);
    const jobs = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
    let next = 0, done = 0, ok = 0;
    const one = (tx, ty) => new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const finish = (good) => { signal.removeEventListener('abort', onAbort); resolve(good ? img : null); };
      const onAbort = () => { img.src = ''; finish(false); };
      signal.addEventListener('abort', onAbort);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = tileUrl(bm, tx, ty, z);
    });
    const worker = async () => {
      while (next < jobs.length && !signal.aborted) {
        const [tx, ty] = jobs[next++];
        const img = await one(tx, ty);
        if (img && img.naturalWidth) {
          const lonW = tx / (1 << z) * 360 - 180, lonE = (tx + 1) / (1 << z) * 360 - 180;
          const latN = y2lat(ty, z), latS = y2lat(ty + 1, z);
          const dx = (lonW - b.w) / (b.e - b.w) * iw, dy = (b.n - latN) / (b.n - b.s) * ih;
          const dw = (lonE - lonW) / (b.e - b.w) * iw, dh = (latN - latS) / (b.n - b.s) * ih;
          ctx.drawImage(img, dx, dy, dw + 0.5, dh + 0.5); // +0.5 hides hairline seams
          ok++;
        }
        onProgress(++done, jobs.length);
      }
    };
    onProgress(0, jobs.length);
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!ok) throw new Error('none of its map tiles could be loaded');
    return canvas;
  }

  // ---------- the viewer ----------
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildOverlay() {
    const overlay = el('div', 'position:fixed;inset:0;z-index:10000;background:#0b1220;touch-action:none;font:13px system-ui,sans-serif;color:#e2e8f0;');
    overlay.className = 'terrain3d-overlay';
    overlay.innerHTML = `
      <canvas style="width:100%;height:100%;display:block;"></canvas>
      <div data-labels style="position:absolute;inset:0;pointer-events:none;overflow:hidden;"></div>
      <div style="position:absolute;top:10px;left:10px;right:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;pointer-events:none;">
        <div data-panel style="background:rgba(15,23,42,0.85);padding:10px 12px;border-radius:8px;pointer-events:auto;max-width:520px;line-height:1.45;">
          <b>3D Terrain View</b> <span data-info style="color:#94a3b8;"></span>
          <div data-status style="margin-top:4px;">Preparing…</div>
          <div data-controls style="display:none;">
            <details data-help style="color:#cbd5e1;margin-top:2px;" open><summary style="cursor:pointer;color:#e2e8f0;">How to move around</summary>
              <div><b>Mouse:</b> drag to move &middot; right-drag (or Ctrl+drag) to rotate and tilt &middot; scroll to zoom &middot; double-click to zoom in there</div>
              <div><b>Touch:</b> one finger to move &middot; pinch to zoom &middot; twist two fingers to rotate &middot; slide two fingers up/down to tilt &middot; double-tap to zoom in</div>
              <div><b>Keys:</b> arrows or W/A/S/D move &middot; Q/E rotate &middot; R/F tilt &middot; +/&minus; zoom &middot; Esc closes</div>
            </details>
            <label style="display:block;margin-top:6px;">Vertical exaggeration
              <input data-exag type="range" min="1" max="20" step="0.5" value="3" style="vertical-align:middle;width:130px;">
              <span data-exag-val>3x</span></label>
            <label style="display:block;">Sun direction
              <input data-sun type="range" min="0" max="360" step="5" value="315" style="vertical-align:middle;width:130px;">
              <span data-sun-val>315&deg;</span></label>
            <label data-surface-row style="display:block;">Surface
              <select data-surface style="vertical-align:middle;max-width:240px;padding:2px 4px;border-radius:4px;color:#0f172a;background:#f8fafc;border:1px solid #94a3b8;">
                <option value="terrain">Natural terrain colours</option>
              </select></label>
            <label data-names-row style="display:block;"><input data-names type="checkbox" checked> Show cave names</label>
            <div data-heat-row>
              <label style="display:block;"><input data-heat-on type="checkbox"> Heatmap</label>
              <label style="display:block;">Heatmap opacity
                <input data-heat-opacity type="range" min="0" max="100" step="5" value="50" style="vertical-align:middle;width:130px;">
                <span data-heat-opacity-val>50%</span></label>
            </div>
            <label style="display:block;"><input data-contour-on type="checkbox"> Contour lines</label>
            <label style="display:block;">Contour interval
              <input data-contour type="range" min="1" max="21" step="1" value="10" style="vertical-align:middle;width:130px;">
              <span data-contour-val>10 ft</span></label>
          </div>
        </div>
        <button data-close style="margin-left:auto;pointer-events:auto;padding:8px 14px;border:none;border-radius:6px;background:#f1f5f9;color:#0f172a;cursor:pointer;font-weight:600;">Close 3D view</button>
      </div>
      <div data-pad class="t3d-pad" style="display:none;">
        <button type="button" class="t3d-compass" data-compass title="Turn to face north" aria-label="Turn to face north">
          <span data-needle class="t3d-needle"><b>N</b><i></i></span>
        </button>
        <div class="t3d-grid">
          <button type="button" class="t3d-btn" data-hold="zin" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" class="t3d-btn" data-hold="zout" title="Zoom out" aria-label="Zoom out">&minus;</button>
          <button type="button" class="t3d-btn" data-hold="rotl" title="Rotate left" aria-label="Rotate left">&#10226;</button>
          <button type="button" class="t3d-btn" data-hold="rotr" title="Rotate right" aria-label="Rotate right">&#10227;</button>
          <button type="button" class="t3d-btn t3d-small" data-hold="tup" title="Tilt toward the horizon">Tilt &#9650;</button>
          <button type="button" class="t3d-btn t3d-small" data-hold="tdn" title="Tilt to look straight down">Tilt &#9660;</button>
          <button type="button" class="t3d-btn t3d-small t3d-wide" data-reset title="Back to the starting view">Reset view</button>
        </div>
      </div>
      <style>
        .terrain3d-overlay .t3d-pad { position:absolute; right:14px; bottom:14px; display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
        .terrain3d-overlay .t3d-grid { display:grid; grid-template-columns:repeat(2, 56px); gap:6px; }
        .terrain3d-overlay .t3d-btn { margin:0; padding:0; height:48px; border:none; border-radius:8px; background:rgba(248,250,252,0.94);
          color:#0f172a; font:700 22px system-ui, sans-serif; cursor:pointer; touch-action:none; user-select:none; -webkit-user-select:none;
          box-shadow:0 1px 4px rgba(0,0,0,0.35); }
        .terrain3d-overlay .t3d-btn.t3d-small { font-size:13px; }
        .terrain3d-overlay .t3d-btn.t3d-wide { grid-column:span 2; height:38px; }
        .terrain3d-overlay .t3d-btn:hover { background:#ffffff; }
        .terrain3d-overlay .t3d-btn:active { background:#1e3a5f; color:#ffffff; }
        .terrain3d-overlay .t3d-compass { margin:0; padding:0; width:56px; height:56px; border-radius:50%; border:none; cursor:pointer;
          background:rgba(248,250,252,0.94); box-shadow:0 1px 4px rgba(0,0,0,0.35); position:relative; }
        .terrain3d-overlay .t3d-needle { position:absolute; inset:0; display:block; pointer-events:none; }
        .terrain3d-overlay .t3d-needle b { position:absolute; top:4px; left:0; right:0; text-align:center; font:700 12px system-ui, sans-serif; color:#b91c1c; }
        .terrain3d-overlay .t3d-needle i { position:absolute; left:50%; top:19px; margin-left:-6px; border-left:6px solid transparent;
          border-right:6px solid transparent; border-bottom:22px solid #b91c1c; }
        .terrain3d-overlay details[data-help] summary { outline:none; }
        @media (max-width: 600px) { .terrain3d-overlay [data-panel] { font-size:12px; } }
      </style>`;
    const q = (s) => overlay.querySelector(s);
    return { overlay, q };
  }

  function open(opts) {
    if (active) active.close();
    if (typeof GeoTIFF === 'undefined') { alert('The 3D view needs the GeoTIFF library, which did not load. Reload the page and try again.'); return; }
    const b = opts.bounds;
    if (!b || !(b.n > b.s) || !(b.e > b.w)) return;
    const markers = (opts.markers || []).filter(m => m.lat <= b.n && m.lat >= b.s && m.lng >= b.w && m.lng <= b.e);

    const { overlay, q } = buildOverlay();
    document.body.appendChild(overlay);
    const status = q('[data-status]');
    const abort = new AbortController();
    let renderer = null, closed = false;

    const onKeyClose = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKeyClose);
    function close() {
      if (closed) return;
      closed = true;
      abort.abort();
      window.removeEventListener('keydown', onKeyClose);
      if (renderer) renderer.dispose();
      overlay.remove();
      if (active && active.close === close) active = null;
      if (opts.onClose) opts.onClose();
    }
    q('[data-close]').addEventListener('click', close);
    active = { close };

    const plan = planGrid(b);
    q('[data-info]').textContent = `· ${(plan.widthM / 1000).toFixed(2)} × ${(plan.heightM / 1000).toFixed(2)} km at ${plan.res < 10 ? plan.res.toFixed(1) : Math.round(plan.res)} m/px`;
    downloadDEM(plan, abort.signal, (d, n) => { status.textContent = `Downloading USGS elevation data… ${d} of ${n}`; })
      .then(grid => {
        if (closed) return;
        let valid = 0;
        for (let i = 0; i < grid.data.length; i++) if (grid.data[i] >= ND) valid++;
        if (!valid) { status.textContent = 'No elevation data here. USGS 3DEP covers the United States only.'; return; }
        status.textContent = 'Building 3D surface…';
        // Let the status repaint before the (blocking) mesh build
        setTimeout(() => {
          if (closed) return;
          try {
            renderer = startRenderer(overlay, q, grid, markers, opts.basemaps || [], abort.signal);
            status.textContent = plan.res > 10
              ? `Showing ${markers.length} cave(s). This is a large area, so detail is coarse. Zoom in or draw a smaller box for up to 1 m detail.`
              : `Showing ${markers.length} cave(s).`;
          } catch (err) {
            console.error(err);
            status.textContent = 'Could not start the 3D view: ' + err.message;
          }
        }, 30);
      })
      .catch(err => {
        if (err.name === 'AbortError' || closed) return;
        console.error(err);
        status.textContent = 'Could not download elevation data: ' + err.message + '. Check your connection and try again.';
      });
    return active;
  }

  // Builds the mesh, textures and markers and runs the render loop.
  function startRenderer(overlay, q, g, markers, basemaps, signal) {
    const canvas = q('canvas');
    const gl = canvas.getContext('webgl', { antialias: true });
    if (!gl) throw new Error('WebGL is not available in this browser (or too many 3D views are open)');
    const uintExt = gl.getExtension('OES_element_index_uint');
    const res = g.res, RW = g.w, RH = g.h, rb = g.bounds;

    // Resample the grid to ow x oh cells, ignoring NoData: box-average when
    // shrinking, bilinear when (nearly) 1:1 or enlarging.
    function resample(ow, oh) {
      const out = new Float32Array(ow * oh);
      if (RW / ow < 1.5 && RH / oh < 1.5) {
        const at = (r, c) => g.data[Math.min(RH - 1, Math.max(0, r)) * RW + Math.min(RW - 1, Math.max(0, c))];
        for (let or = 0; or < oh; or++) {
          const fy = (or + 0.5) * RH / oh - 0.5, y0 = Math.floor(fy), ty = fy - y0;
          for (let oc = 0; oc < ow; oc++) {
            const fx = (oc + 0.5) * RW / ow - 0.5, x0 = Math.floor(fx), tx = fx - x0;
            const a = at(y0, x0), b = at(y0, x0 + 1), c = at(y0 + 1, x0), d = at(y0 + 1, x0 + 1);
            out[or * ow + oc] = (a < ND || b < ND || c < ND || d < ND)
              ? (a >= ND ? a : NODATA)
              : (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
          }
        }
        return out;
      }
      for (let or = 0; or < oh; or++) {
        const sr0 = Math.floor(or * RH / oh), sr1 = Math.max(sr0 + 1, Math.floor((or + 1) * RH / oh));
        for (let oc = 0; oc < ow; oc++) {
          const sc0 = Math.floor(oc * RW / ow), sc1 = Math.max(sc0 + 1, Math.floor((oc + 1) * RW / ow));
          let sum = 0, cnt = 0;
          for (let r = sr0; r < sr1; r++) for (let c = sc0; c < sc1; c++) { const v = g.data[r * RW + c]; if (v >= ND) { sum += v; cnt++; } }
          out[or * ow + oc] = cnt ? sum / cnt : NODATA;
        }
      }
      return out;
    }

    // ---- Mesh: up to 1536 x 1536 vertices (255 without 32-bit indices,
    // which every browser that still gets a 3D view at all supports) ----
    const maxGrid = uintExt ? 1536 : 255;
    const ms = Math.max(1, Math.max(RW, RH) / maxGrid);
    const gw = Math.max(2, Math.round(RW / ms)), gh = Math.max(2, Math.round(RH / ms));
    const meshZ = resample(gw, gh);
    let minZ = Infinity, maxZ = -Infinity;
    for (const z of meshZ) if (z >= ND) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
    if (!isFinite(minZ)) { minZ = 0; maxZ = 1; }
    const relief = Math.max(1, maxZ - minZ);
    const sizeX = RW * res, sizeZ = RH * res, cx = sizeX / 2, cz = sizeZ / 2;
    const extent = Math.max(sizeX, sizeZ);
    const nV = gw * gh;
    const pos = new Float32Array(nV * 3), uv = new Float32Array(nV * 2);
    for (let gr = 0; gr < gh; gr++) for (let gc = 0; gc < gw; gc++) {
      const v = gr * gw + gc, z = meshZ[v];
      pos[v * 3] = gc / (gw - 1) * sizeX - cx; pos[v * 3 + 1] = z >= ND ? z - minZ : 0; pos[v * 3 + 2] = gr / (gh - 1) * sizeZ - cz;
      uv[v * 2] = gc / (gw - 1); uv[v * 2 + 1] = gr / (gh - 1);
    }

    // Finds where the terrain crosses each contour level (in feet), on a
    // coarse grid separate from the render mesh so this stays cheap however
    // high-res the mesh is. One point per crossing cell+level, then thinned
    // to a minimum on-ground spacing and an overall cap so long contour
    // lines get a few spread-out labels (like a paper topo map) instead of
    // a solid wall of text.
    const LW = 160, LH = Math.max(2, Math.round(LW * sizeZ / sizeX));
    const MAX_CONTOUR_LABELS = 100; // headroom above ZONES*ZONES*MAX_PER_ZONE below, so the per-zone cap normally decides this on its own
    function buildContourLabelPoints(intervalFt) {
      const lgrid = resample(LW, LH);
      const elevFt = (r, c) => { const v = lgrid[r * LW + c]; return v >= ND ? v * 3.28084 : null; };
      const raw = [];
      for (let lr = 0; lr < LH - 1; lr++) {
        for (let lc = 0; lc < LW - 1; lc++) {
          const e00 = elevFt(lr, lc), e10 = elevFt(lr, lc + 1), e01 = elevFt(lr + 1, lc), e11 = elevFt(lr + 1, lc + 1);
          if (e00 == null || e10 == null || e01 == null || e11 == null) continue;
          const lo = Math.min(e00, e10, e01, e11), hi = Math.max(e00, e10, e01, e11);
          const l0 = Math.ceil(lo / intervalFt), l1 = Math.floor(hi / intervalFt);
          for (let li = l0; li <= l1 && li - l0 < 8; li++) {
            const level = li * intervalFt;
            // Any one crossing edge of this cell gives a point close enough
            // to the true isoline for a label anchor.
            const edges = [[e00, e10, lc, lr, lc + 1, lr], [e10, e11, lc + 1, lr, lc + 1, lr + 1],
              [e11, e01, lc + 1, lr + 1, lc, lr + 1], [e01, e00, lc, lr + 1, lc, lr]];
            for (const [a, b, c0, r0, c1, r1] of edges) {
              if (a === b || (a - level) * (b - level) > 0) continue;
              const t = (level - a) / (b - a);
              const gcF = c0 + (c1 - c0) * t, grF = r0 + (r1 - r0) * t;
              raw.push({
                x: gcF / (LW - 1) * sizeX - cx,
                z: grF / (LH - 1) * sizeZ - cz,
                y: level / 3.28084 - minZ,
                levelFt: level,
              });
              break;
            }
          }
        }
      }
      // Thin by SPATIAL ZONE, not by elevation level or scan order: a
      // hilly patch generates far more crossing points per unit area than
      // a flat one (its lines double back through many more coarse grid
      // cells), so picking evenly "per level" or "every Nth point found"
      // still over-represents whichever area happens to be hillier -
      // exactly the bug reported (labels piling up over the relief at one
      // end of the box, none over the flatter ground making up most of
      // it). Dividing the box into a grid of zones and capping how many
      // labels (and distinct levels) each zone contributes guarantees
      // coverage across the whole visible area regardless of how unevenly
      // the raw crossings are distributed.
      const ZONES = 7, MAX_PER_ZONE = 2;
      const zoneCounts = new Array(ZONES * ZONES).fill(0);
      const zoneLevels = new Array(ZONES * ZONES).fill(null).map(() => new Set());
      const kept = [];
      for (const p of raw) {
        const zc = Math.min(ZONES - 1, Math.max(0, Math.floor((p.x + cx) / sizeX * ZONES)));
        const zr = Math.min(ZONES - 1, Math.max(0, Math.floor((p.z + cz) / sizeZ * ZONES)));
        const zi = zr * ZONES + zc;
        if (zoneCounts[zi] >= MAX_PER_ZONE || zoneLevels[zi].has(p.levelFt)) continue;
        zoneLevels[zi].add(p.levelFt);
        zoneCounts[zi]++;
        kept.push(p);
      }
      if (kept.length <= MAX_CONTOUR_LABELS) return kept;
      const out = [], step = kept.length / MAX_CONTOUR_LABELS;
      for (let i = 0; i < MAX_CONTOUR_LABELS; i++) out.push(kept[Math.floor(i * step)]);
      return out;
    }
    const nIdx = (gw - 1) * (gh - 1) * 6;
    const idx = nV > 65535 ? new Uint32Array(nIdx) : new Uint16Array(nIdx);
    let k = 0;
    for (let gr = 0; gr < gh - 1; gr++) for (let gc = 0; gc < gw - 1; gc++) {
      const a = gr * gw + gc, b = a + 1, c2 = a + gw, d = c2 + 1;
      idx[k++] = a; idx[k++] = c2; idx[k++] = b; idx[k++] = b; idx[k++] = c2; idx[k++] = d;
    }

    // ---- Normal + colour textures at (up to) full resolution ----
    const maxTex = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const pot = (x) => Math.min(maxTex, Math.pow(2, Math.max(6, Math.round(Math.log2(Math.max(1, x))))));
    let tw = pot(RW), th = pot(RH);
    while (tw * th > 16e6) { if (tw >= th) tw /= 2; else th /= 2; }
    const texZ = resample(tw, th);
    const dxM = sizeX / tw, dzM = sizeZ / th;
    const nrmPx = new Uint8Array(tw * th * 4), albPx = new Uint8Array(tw * th * 4);
    const zT = (r, c) => texZ[Math.min(th - 1, Math.max(0, r)) * tw + Math.min(tw - 1, Math.max(0, c))];
    for (let r = 0; r < th; r++) for (let c = 0; c < tw; c++) {
      const i = r * tw + c, z = texZ[i], o = i * 4;
      if (z < ND) { nrmPx.set([128, 255, 128, 255], o); albPx.set([25, 25, 28, 255], o); continue; }
      const zl = zT(r, c - 1), zr = zT(r, c + 1), zu = zT(r - 1, c), zd = zT(r + 1, c);
      const dzdx = ((zr >= ND ? zr : z) - (zl >= ND ? zl : z)) / (2 * dxM);
      const dzds = ((zd >= ND ? zd : z) - (zu >= ND ? zu : z)) / (2 * dzM); // toward the south (+z)
      const nl = Math.hypot(dzdx, 1, dzds);
      nrmPx[o] = (-dzdx / nl * 0.5 + 0.5) * 255; nrmPx[o + 1] = (1 / nl * 0.5 + 0.5) * 255; nrmPx[o + 2] = (-dzds / nl * 0.5 + 0.5) * 255; nrmPx[o + 3] = 255;
      // Natural colouring: soil/leaf litter on gentle ground, grey rock on
      // steep faces, a little lighter with elevation.
      const slopeDeg = Math.atan(Math.hypot(dzdx, dzds)) * 180 / Math.PI;
      const rock = Math.min(1, Math.max(0, (slopeDeg - 28) / 20));
      const t = (z - minZ) / relief;
      albPx[o] = ((0.40 + 0.08 * t) * (1 - rock) + 0.58 * rock) * 255;
      albPx[o + 1] = ((0.40 + 0.06 * t) * (1 - rock) + 0.56 * rock) * 255;
      albPx[o + 2] = ((0.27 + 0.05 * t) * (1 - rock) + 0.52 * rock) * 255;
      albPx[o + 3] = 255;
    }
    const mkTex = (px) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (px instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, px); // a canvas (draped imagery)
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      return t;
    };
    const texNrm = mkTex(nrmPx), texAlb = mkTex(albPx);

    // ---- Cave pins: a vertical stalk with a dot on top, grouped by colour ----
    // Default exaggeration: enough to read the relief (Florida is flat).
    let zScale = Math.min(10, Math.max(1, Math.round(2 * 0.06 * extent / relief) / 2));
    const stalk = Math.max(10, relief * 0.15);
    const groups = new Map();
    const pins = []; // { x, y, z, label } in mesh coordinates
    for (const m of markers) {
      const fr = (rb.n - m.lat) / (rb.n - rb.s), fc = (m.lng - rb.w) / (rb.e - rb.w);
      const zi = meshZ[Math.min(gh - 1, Math.round(fr * (gh - 1))) * gw + Math.min(gw - 1, Math.round(fc * (gw - 1)))];
      const p = { x: fc * sizeX - cx, y: zi >= ND ? zi - minZ : 0, z: fr * sizeZ - cz, label: m.label || '' };
      pins.push(p);
      const key = (m.color || '#dc2626').toLowerCase();
      if (!groups.has(key)) groups.set(key, { rgb: hexRGB(key), pins: [] });
      groups.get(key).pins.push(p);
    }
    const mk = [], mkGroups = [];
    for (const grp of groups.values()) {
      mkGroups.push({ rgb: grp.rgb, start: mk.length / 6, count: grp.pins.length });
      for (const p of grp.pins) mk.push(p.x, p.y, p.z, p.x, p.y + stalk, p.z);
    }
    const markerPos = new Float32Array(mk.length ? mk : [0, 0, 0]);

    // ---- Heatmap texture: cave density, draped over the terrain the same
    // way basemap imagery is (same v_uv, same mkTex()). Built once here
    // (positions don't change during the session) rather than per frame.
    // Each cave draws a soft radial blob that accumulates (brighter where
    // caves cluster, same idea as the 2D map's Waypoints Heatmap), then the
    // accumulated alpha is colourised through a blue -> red gradient; the
    // alpha itself becomes each pixel's blend weight in the shader, so
    // empty ground stays fully transparent regardless of opacity.
    function buildHeatCanvas() {
      // Power-of-two in both dimensions, like texNrm/texAlb above (via the
      // same pot() helper) - mkTex() below calls generateMipmap(), which
      // WebGL1 silently fails on a non-power-of-two texture, leaving it
      // "mipmap incomplete" and sampling as solid black.
      const HW = pot(512), HH = pot(Math.max(2, Math.round(512 * sizeZ / sizeX)));
      const canvas = document.createElement('canvas');
      canvas.width = HW; canvas.height = HH;
      const ctx = canvas.getContext('2d');
      if (!pins.length) return canvas; // blank/transparent - nothing to show
      const r = Math.max(8, Math.max(HW, HH) * 0.035);
      const blob = document.createElement('canvas');
      blob.width = blob.height = r * 2;
      const bctx = blob.getContext('2d');
      const grad = bctx.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      bctx.fillStyle = grad;
      bctx.fillRect(0, 0, r * 2, r * 2);
      ctx.globalAlpha = 0.5;
      for (const p of pins) {
        const px = (p.x + cx) / sizeX * HW, py = (p.z + cz) / sizeZ * HH;
        ctx.drawImage(blob, px - r, py - r);
      }
      ctx.globalAlpha = 1;
      // Blue -> cyan -> lime -> yellow -> red, matching the 2D heatmap's
      // default gradient.
      const stops = [[0.0, 0, 0, 255], [0.4, 0, 0, 255], [0.6, 0, 255, 255], [0.7, 0, 255, 0], [0.8, 255, 255, 0], [1.0, 255, 0, 0]];
      const lut = new Uint8Array(256 * 3);
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let s0 = stops[0], s1 = stops[stops.length - 1];
        for (let k = 0; k < stops.length - 1; k++) {
          if (t >= stops[k][0] && t <= stops[k + 1][0]) { s0 = stops[k]; s1 = stops[k + 1]; break; }
        }
        const f = Math.min(1, Math.max(0, (t - s0[0]) / Math.max(1e-6, s1[0] - s0[0])));
        lut[i * 3] = s0[1] + (s1[1] - s0[1]) * f;
        lut[i * 3 + 1] = s0[2] + (s1[2] - s0[2]) * f;
        lut[i * 3 + 2] = s0[3] + (s1[3] - s0[3]) * f;
      }
      const img = ctx.getImageData(0, 0, HW, HH);
      const data = img.data;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (!a) continue;
        data[i] = lut[a * 3]; data[i + 1] = lut[a * 3 + 1]; data[i + 2] = lut[a * 3 + 2];
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    }
    const texHeat = mkTex(buildHeatCanvas());

    // Cave-name labels (the MAX_LABELS pins nearest the middle of the box)
    const labelLayer = q('[data-labels]');
    const labeled = pins.filter(p => p.label).sort((a, b2) => Math.hypot(a.x, a.z) - Math.hypot(b2.x, b2.z)).slice(0, MAX_LABELS);
    for (const p of labeled) {
      p.el = el('div', 'position:absolute;left:0;top:0;white-space:nowrap;font-size:11px;padding:1px 5px;border-radius:3px;background:rgba(15,23,42,0.75);color:#f8fafc;display:none;will-change:transform;', p.label);
      labelLayer.appendChild(p.el);
    }
    const namesBox = q('[data-names]');
    if (!labeled.length) q('[data-names-row]').style.display = 'none';

    // Contour elevation labels - built on demand (contour turned on, or its
    // interval changed), not every frame; only their screen projection is
    // recomputed per frame, same as the cave-name labels above.
    let contourLabelPoints = [];
    function rebuildContourLabels(intervalFt) {
      for (const p of contourLabelPoints) p.el.remove();
      contourLabelPoints = buildContourLabelPoints(intervalFt).map((p) => {
        p.el = el('div', 'position:absolute;left:0;top:0;white-space:nowrap;font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;background:rgba(255,128,0,0.85);color:#1a0f00;display:none;will-change:transform;pointer-events:none;', `${Math.round(p.levelFt)} ft`);
        labelLayer.appendChild(p.el);
        return p;
      });
    }
    function clearContourLabels() {
      for (const p of contourLabelPoints) p.el.remove();
      contourLabelPoints = [];
    }

    // ---- Shaders ----
    // Contour lines are blended on top of `c` below - after the terrain
    // colour/draped-imagery choice is resolved - so they show the same way
    // over natural terrain colours or any draped basemap. Anti-aliased with
    // fwidth() (from OES_standard_derivatives) when available so the lines
    // stay crisp at any distance/zoom instead of shimmering; a slightly
    // softer fixed-width fallback covers the rare GPU without that
    // extension.
    const derivExt = gl.getExtension('OES_standard_derivatives');
    const vs = `attribute vec3 a_pos; attribute vec2 a_uv;
      uniform mat4 u_mvp; uniform float u_zScale; uniform vec3 u_eye; uniform float u_pointSize; uniform float u_minZ;
      varying vec2 v_uv; varying float v_dist; varying float v_elevFt;
      void main() {
        vec3 p = vec3(a_pos.x, a_pos.y * u_zScale, a_pos.z);
        gl_Position = u_mvp * vec4(p, 1.0);
        gl_PointSize = u_pointSize;
        v_uv = a_uv; v_dist = distance(p, u_eye);
        v_elevFt = (a_pos.y + u_minZ) * 3.28084;
      }`;
    const fs = `${derivExt ? '#extension GL_OES_standard_derivatives : enable\n' : ''}precision mediump float;
      varying vec2 v_uv; varying float v_dist; varying float v_elevFt;
      uniform sampler2D u_nrm; uniform sampler2D u_alb; uniform sampler2D u_heat;
      uniform vec3 u_sun; uniform float u_nScale; uniform float u_flat; uniform vec3 u_flatColor; uniform float u_fogFar; uniform float u_img;
      uniform float u_contourOn; uniform float u_contourInterval; uniform vec3 u_contourColor;
      uniform float u_heatOn; uniform float u_heatOpacity;
      void main() {
        if (u_flat > 0.5) { gl_FragColor = vec4(u_flatColor, 1.0); return; }
        vec3 n = texture2D(u_nrm, v_uv).xyz * 2.0 - 1.0;
        n = normalize(vec3(n.x * u_nScale, n.y, n.z * u_nScale)); // exaggeration steepens the normal
        vec3 alb = texture2D(u_alb, v_uv).rgb;
        float d = max(dot(n, u_sun), 0.0);
        float sky = 0.25 + 0.15 * n.y;
        float light = sky + 0.75 * d;
        // Draped map imagery already has its own colours (and, for aerial
        // photos, shadows), so the relief shading is applied more gently.
        vec3 c = u_img > 0.5 ? alb * mix(1.0, light / 0.9, 0.6) : alb * light;
        // Heatmap sits above the terrain/draped basemap but below the cave
        // pins and labels (those are drawn in later passes/as HTML, on top
        // of this one) - blended before contour lines so the lines stay
        // crisp on top of the colour wash rather than tinted by it.
        if (u_heatOn > 0.5) {
          vec4 heat = texture2D(u_heat, v_uv);
          c = mix(c, heat.rgb, heat.a * u_heatOpacity);
        }
        if (u_contourOn > 0.5) {
          float m = mod(v_elevFt, u_contourInterval);
          float distToLine = min(m, u_contourInterval - m);
          ${derivExt
            ? 'float lineWidth = max(0.02, fwidth(v_elevFt)) * 1.25; float mixAmt = 1.0 - smoothstep(0.0, lineWidth, distToLine);'
            : 'float mixAmt = 1.0 - smoothstep(0.0, max(0.05, u_contourInterval * 0.02), distToLine);'}
          c = mix(c, u_contourColor, mixAmt * 0.85);
        }
        float fog = clamp(v_dist / u_fogFar, 0.0, 1.0) * 0.5;
        gl_FragColor = vec4(mix(c, vec3(0.55, 0.62, 0.72), fog), 1.0);
      }`;
    const prog = gl.createProgram();
    gl.attachShader(prog, createShader(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, createShader(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('shader link failed: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const uni = (n) => gl.getUniformLocation(prog, n);
    const aPos = gl.getAttribLocation(prog, 'a_pos'), aUv = gl.getAttribLocation(prog, 'a_uv');
    const mkBuf = (data, target) => { const bf = gl.createBuffer(); gl.bindBuffer(target || gl.ARRAY_BUFFER, bf); gl.bufferData(target || gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return bf; };
    const bPos = mkBuf(pos), bUv = mkBuf(uv), bIdx = mkBuf(idx, gl.ELEMENT_ARRAY_BUFFER), bMk = mkBuf(markerPos);
    const uMvp = uni('u_mvp'), uZ = uni('u_zScale'), uNScale = uni('u_nScale'), uEye = uni('u_eye'), uSun = uni('u_sun'),
      uFlat = uni('u_flat'), uFlatColor = uni('u_flatColor'), uFog = uni('u_fogFar'), uPt = uni('u_pointSize'), uImg = uni('u_img'),
      uMinZ = uni('u_minZ'), uContourOn = uni('u_contourOn'), uContourInterval = uni('u_contourInterval'), uContourColor = uni('u_contourColor'),
      uHeatOn = uni('u_heatOn'), uHeatOpacity = uni('u_heatOpacity');
    gl.uniform1i(uni('u_nrm'), 0); gl.uniform1i(uni('u_alb'), 1); gl.uniform1i(uni('u_heat'), 2);
    gl.uniform1f(uMinZ, minZ);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.55, 0.62, 0.72, 1); // hazy sky, matching the fog

    // ---- Controls ----
    q('[data-controls]').style.display = 'block';
    q('[data-pad]').style.display = 'flex';
    // Fold the help away on small screens so it doesn't cover the view
    if (window.innerWidth < 700 || window.innerHeight < 750) q('[data-help]').open = false;
    const exagEl = q('[data-exag]'), sunEl = q('[data-sun]');
    exagEl.value = zScale; q('[data-exag-val]').textContent = zScale + 'x';
    // Surface: natural colours, or one of the map's basemaps draped on top
    let texImg = null, useImg = false;
    const imgCache = new Map();
    const surfaceEl = q('[data-surface]'), statusEl = q('[data-status]'), statusText = () => statusEl.textContent;
    basemaps.forEach((bm, i) => {
      const op = document.createElement('option');
      op.value = String(i); op.textContent = bm.label + (bm.active ? ' (shown on the map now)' : '');
      surfaceEl.appendChild(op);
    });
    if (!basemaps.length) q('[data-surface-row]').style.display = 'none';
    const maxImgTex = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    let iw = Math.min(maxImgTex, Math.max(256, tw)), ih = Math.min(maxImgTex, Math.max(256, th));
    while (iw * ih > 8e6) { if (iw >= ih) iw /= 2; else ih /= 2; } // keep the canvas phone-friendly
    let surfaceReq = 0, baseStatus = '';
    surfaceEl.addEventListener('change', async () => {
      const req = ++surfaceReq, v = surfaceEl.value;
      if (!baseStatus) baseStatus = statusText();
      if (v === 'terrain') { useImg = false; statusEl.textContent = baseStatus; return; }
      const bm = basemaps[+v];
      if (imgCache.has(v)) { texImg = imgCache.get(v); useImg = true; statusEl.textContent = baseStatus; return; }
      try {
        const cv = await loadImagery(bm, rb, iw, ih, signal, (d, n) => {
          if (req === surfaceReq) statusEl.textContent = `Loading ${bm.label}… ${d} of ${n} tiles`;
        });
        let t;
        try { t = mkTex(cv); } catch (err) { throw new Error('its server does not allow its tiles to be used in 3D'); }
        imgCache.set(v, t);
        if (req !== surfaceReq) return;
        texImg = t; useImg = true; statusEl.textContent = baseStatus;
      } catch (err) {
        if (err.name === 'AbortError' || req !== surfaceReq) return;
        console.error(err);
        surfaceEl.value = 'terrain'; useImg = false;
        statusEl.textContent = `Couldn't show ${bm.label} in 3D: ${err.message}.`;
      }
    });

    let sunAz = 315;
    sunEl.addEventListener('input', () => { sunAz = parseFloat(sunEl.value); q('[data-sun-val]').textContent = sunAz + '°'; });

    // Heatmap: on/off switch plus an opacity slider, same idea as the 2D
    // map's Waypoints Heatmap. Nothing to show without at least one cave
    // in the box, same as the "Show cave names" row above.
    const heatOnEl = q('[data-heat-on]'), heatOpacityEl = q('[data-heat-opacity]'), heatOpacityValEl = q('[data-heat-opacity-val]');
    let heatOn = false, heatOpacityVal = parseInt(heatOpacityEl.value, 10) / 100;
    if (!pins.length) q('[data-heat-row]').style.display = 'none';
    heatOnEl.addEventListener('change', () => { heatOn = heatOnEl.checked; });
    heatOpacityEl.addEventListener('input', () => {
      heatOpacityVal = parseInt(heatOpacityEl.value, 10) / 100;
      heatOpacityValEl.textContent = heatOpacityEl.value + '%';
    });

    // Contour lines: on/off switch plus an interval slider, same foot
    // intervals as the 2D map's contour control for a consistent feel.
    const CONTOUR_INTERVALS_FT = [100, 80, 60, 50, 40, 30, 25, 20, 15, 10, 8, 6, 5, 4, 3, 2.5, 2, 1.5, 1, 0.5, 0.25];
    const contourOnEl = q('[data-contour-on]'), contourEl = q('[data-contour]'), contourValEl = q('[data-contour-val]');
    const CONTOUR_COLOR = [1, 0.5, 0];
    let contourOn = false, contourIntervalFt = CONTOUR_INTERVALS_FT[9]; // slider default value=10 -> index 9
    let contourLabelTimer = null;
    function scheduleContourLabelRebuild() {
      clearTimeout(contourLabelTimer);
      contourLabelTimer = setTimeout(() => { if (contourOn) rebuildContourLabels(contourIntervalFt); }, 200);
    }
    contourOnEl.addEventListener('change', () => {
      contourOn = contourOnEl.checked;
      if (contourOn) rebuildContourLabels(contourIntervalFt); else clearContourLabels();
    });
    contourEl.addEventListener('input', () => {
      contourIntervalFt = CONTOUR_INTERVALS_FT[Math.max(0, Math.min(CONTOUR_INTERVALS_FT.length - 1, parseInt(contourEl.value, 10) - 1))];
      contourValEl.textContent = (contourIntervalFt < 1 ? contourIntervalFt : Math.round(contourIntervalFt)) + ' ft';
      scheduleContourLabelRebuild();
    });

    // ---- Camera: orbits a point on the ground, like a web map tilted into 3D ----
    // heading 0 = looking north; tilt 0 = looking straight down.
    const FOV = Math.PI / 3, MAX_TILT = 85 * Math.PI / 180;
    const MIN_DIST = Math.max(5, res * 5), MAX_DIST = extent * 4;
    function groundAt(x, z) { // terrain height (unexaggerated, above minZ) at mesh coordinates
      const fx = (x + cx) / sizeX * (gw - 1), fz = (z + cz) / sizeZ * (gh - 1);
      if (!(fx >= 0 && fz >= 0 && fx <= gw - 1 && fz <= gh - 1)) return null;
      const x0 = Math.min(gw - 2, Math.floor(fx)), z0 = Math.min(gh - 2, Math.floor(fz)), tx = fx - x0, tz = fz - z0;
      const h = (r, c) => { const v = meshZ[r * gw + c]; return v >= ND ? v - minZ : 0; };
      return (h(z0, x0) * (1 - tx) + h(z0, x0 + 1) * tx) * (1 - tz) + (h(z0 + 1, x0) * (1 - tx) + h(z0 + 1, x0 + 1) * tx) * tz;
    }
    const groundY = (x, z) => { const h = groundAt(x, z); return h == null ? null : h * zScale; };
    const homeView = () => ({ tx: 0, ty: groundY(0, 0) || 0, tz: 0, dist: extent * 0.7, heading: 0, tilt: 45 * Math.PI / 180 });
    const cam = homeView();
    let anim = null;

    function basis() {
      const sh = Math.sin(cam.heading), chd = Math.cos(cam.heading), st = Math.sin(cam.tilt), ct = Math.cos(cam.tilt);
      const fwd = [sh * st, -ct, -chd * st];
      const right = [chd, 0, sh];
      const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
      const eye = [cam.tx - fwd[0] * cam.dist, cam.ty - fwd[1] * cam.dist, cam.tz - fwd[2] * cam.dist];
      return { eye, fwd, right, up };
    }
    function rayAt(px, py) {
      const b = basis(), w = canvas.clientWidth, h = canvas.clientHeight, t = Math.tan(FOV / 2);
      const nx = (px / w * 2 - 1) * t * (w / Math.max(1, h)), ny = (1 - py / h * 2) * t;
      const d = [0, 1, 2].map(i => b.fwd[i] + b.right[i] * nx + b.up[i] * ny);
      const l = Math.hypot(d[0], d[1], d[2]);
      return { o: b.eye, d: d.map(v => v / l) };
    }
    function planeHit(o, d, y) {
      if (Math.abs(d[1]) < 1e-6) return null;
      const t = (y - o[1]) / d[1];
      return t > 0 ? [o[0] + d[0] * t, y, o[2] + d[2] * t] : null;
    }
    // The point on the terrain under a screen position (ray-marched through
    // the height field); falls back to the level of the current pivot.
    function pickGround(px, py) {
      const { o, d } = rayAt(px, py);
      const topY = relief * zScale + 1;
      let t = 0;
      if (o[1] > topY) { if (d[1] >= 0) return planeHit(o, d, cam.ty); t = (o[1] - topY) / -d[1]; }
      const step = Math.max(res * 0.75, extent / 2000), maxT = t + extent * 3;
      let prev = t;
      for (; t < maxT; t += step) {
        const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
        if (y > topY && d[1] >= 0) break;
        const g = groundY(x, z);
        if (g != null && y <= g) {
          let a = prev, b2 = t;
          for (let i = 0; i < 14; i++) {
            const m = (a + b2) / 2, gm = groundY(o[0] + d[0] * m, o[2] + d[2] * m);
            if (gm != null && o[1] + d[1] * m <= gm) b2 = m; else a = m;
          }
          return [o[0] + d[0] * b2, o[1] + d[1] * b2, o[2] + d[2] * b2];
        }
        prev = t;
      }
      return planeHit(o, d, cam.ty);
    }
    // Move the pivot to the ground at the centre of the screen without
    // changing the view, so rotating and tilting turn around what you see.
    function reanchor() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const hit = pickGround(w / 2, h / 2);
      if (!hit) return;
      const eye = basis().eye, d = Math.hypot(hit[0] - eye[0], hit[1] - eye[1], hit[2] - eye[2]);
      if (d < 1) return;
      cam.tx = hit[0]; cam.ty = hit[1]; cam.tz = hit[2]; cam.dist = d;
    }
    function clampCam() {
      cam.dist = Math.min(MAX_DIST, Math.max(MIN_DIST, cam.dist));
      cam.tilt = Math.min(MAX_TILT, Math.max(0, cam.tilt));
      cam.tx = Math.min(sizeX, Math.max(-sizeX, cam.tx));
      cam.tz = Math.min(sizeZ, Math.max(-sizeZ, cam.tz));
      // Never let the camera end up inside a hill: look down more instead
      for (let i = 0; i < 40 && cam.tilt > 0; i++) {
        const e = basis().eye, g = groundY(e[0], e[2]);
        if (g == null || e[1] >= g + Math.max(2, cam.dist * 0.03)) break;
        cam.tilt = Math.max(0, cam.tilt - 0.03);
      }
    }
    function zoomAbout(P, f) {
      const nd = Math.min(MAX_DIST, Math.max(MIN_DIST, cam.dist * f));
      f = nd / cam.dist;
      if (P) { cam.tx = P[0] + (cam.tx - P[0]) * f; cam.ty = P[1] + (cam.ty - P[1]) * f; cam.tz = P[2] + (cam.tz - P[2]) * f; }
      cam.dist = nd;
      clampCam();
    }
    function animateTo(to, ms) {
      const from = { ...cam };
      let dh = (to.heading ?? cam.heading) - cam.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh)); // turn the short way round
      anim = { from, to: { ...cam, ...to, heading: cam.heading + dh }, t0: performance.now(), ms: ms || 450 };
    }

    exagEl.addEventListener('input', () => {
      const old = zScale;
      zScale = parseFloat(exagEl.value);
      q('[data-exag-val]').textContent = zScale + 'x';
      cam.ty = cam.ty / old * zScale; // keep the pivot on the (re-stretched) ground
      clampCam();
    });

    // ---- Mouse / touch ----
    const pointers = new Map();
    let mode = null, grab = null, last2 = null, lastTap = null, moved = 0;
    const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    function startPan(p) { const hit = pickGround(p.x, p.y); grab = hit ? { P: hit } : null; mode = 'pan'; }
    function twoState() {
      const [a, b2] = [...pointers.values()];
      return { mx: (a.x + b2.x) / 2, my: (a.y + b2.y) / 2, span: Math.max(1, Math.hypot(a.x - b2.x, a.y - b2.y)), ang: Math.atan2(b2.y - a.y, b2.x - a.x) };
    }
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      anim = null;
      canvas.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      moved = 0;
      if (pointers.size === 1) {
        if (e.button === 2 || e.ctrlKey || e.metaKey || e.shiftKey) { reanchor(); mode = 'rotate'; last2 = p; }
        else startPan(p);
      } else if (pointers.size === 2) {
        reanchor(); mode = 'touch2'; last2 = twoState();
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prevP = pointers.get(e.pointerId), p = local(e);
      pointers.set(e.pointerId, p);
      moved += Math.hypot(p.x - prevP.x, p.y - prevP.y);
      if (mode === 'pan' && grab) {
        // Keep the grabbed point of ground under the pointer
        const { o, d } = rayAt(p.x, p.y);
        const hit = planeHit(o, d, grab.P[1]);
        if (hit) {
          let dx = grab.P[0] - hit[0], dz = grab.P[2] - hit[2];
          const lim = cam.dist * 2, len = Math.hypot(dx, dz); // ray near the horizon: don't fling
          if (len > lim) { dx *= lim / len; dz *= lim / len; }
          cam.tx += dx; cam.tz += dz;
          clampCam();
        }
      } else if (mode === 'rotate') {
        cam.heading -= (p.x - last2.x) * 0.006;
        cam.tilt -= (p.y - last2.y) * 0.006;
        last2 = p;
        clampCam();
      } else if (mode === 'touch2' && pointers.size === 2) {
        const now = twoState();
        const P = pickGround(now.mx, now.my);
        zoomAbout(P, last2.span / now.span);              // pinch
        const da = now.ang - last2.ang;
        cam.heading -= Math.atan2(Math.sin(da), Math.cos(da)); // twist
        cam.tilt -= (now.my - last2.my) * 0.006;           // slide up/down together
        clampCam();
        last2 = now;
      }
    });
    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      const p = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size === 1) { startPan([...pointers.values()][0]); return; } // lifted one of two fingers
      if (pointers.size) return;
      if (mode === 'pan') reanchor();
      mode = null; grab = null;
      // Double-click / double-tap: zoom in on that spot
      if (e.type === 'pointerup' && moved < 6) {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
          const P = pickGround(p.x, p.y);
          if (P) animateTo({ tx: P[0], ty: P[1], tz: P[2], dist: Math.max(MIN_DIST, cam.dist * 0.45) });
          lastTap = null;
        } else lastTap = { t: now, x: p.x, y: p.y };
      }
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      anim = null;
      const p = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      zoomAbout(pickGround(p.x, p.y), Math.exp(Math.max(-300, Math.min(300, dy)) * 0.0015));
    }, { passive: false });

    // ---- On-screen buttons (hold to keep going) and keys ----
    const held = new Set();
    overlay.querySelectorAll('[data-hold]').forEach(btn => {
      const k2 = 'btn-' + btn.dataset.hold;
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); anim = null; reanchor(); held.add(k2); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, () => held.delete(k2)));
    });
    q('[data-reset]').addEventListener('click', () => animateTo(homeView(), 600));
    q('[data-compass]').addEventListener('click', () => { reanchor(); animateTo({ heading: 0 }); });
    const needle = q('[data-needle]');
    const keyMap = { arrowup: 'fwd', w: 'fwd', arrowdown: 'back', s: 'back', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right',
      q: 'rotl', e: 'rotr', r: 'tup', f: 'tdn', '+': 'zin', '=': 'zin', '-': 'zout', '_': 'zout', shift: 'fast' };
    const onKey = (e, down) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
      const k3 = keyMap[e.key.toLowerCase()];
      if (!k3) return;
      e.preventDefault();
      if (down) { if (!held.has('key-' + k3) && k3 !== 'fast') { anim = null; reanchor(); } held.add('key-' + k3); }
      else held.delete('key-' + k3);
    };
    const kd = (e) => onKey(e, true), ku = (e) => onKey(e, false);
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    const on = (n) => held.has('btn-' + n) || held.has('key-' + n);
    let last = performance.now(), raf = 0;

    function frame(now) {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (anim) {
        const t = Math.min(1, (now - anim.t0) / anim.ms), k4 = t * t * (3 - 2 * t);
        for (const key of ['tx', 'ty', 'tz', 'heading', 'tilt']) cam[key] = anim.from[key] + (anim.to[key] - anim.from[key]) * k4;
        cam.dist = Math.exp(Math.log(anim.from.dist) + (Math.log(anim.to.dist) - Math.log(anim.from.dist)) * k4);
        if (t >= 1) anim = null;
        clampCam();
      }
      if (held.size) {
        const fast = on('fast') ? 3 : 1, mv = cam.dist * 0.9 * dt * fast;
        const fx = Math.sin(cam.heading), fz = -Math.cos(cam.heading);
        if (on('fwd')) { cam.tx += fx * mv; cam.tz += fz * mv; }
        if (on('back')) { cam.tx -= fx * mv; cam.tz -= fz * mv; }
        if (on('left')) { cam.tx += fz * mv; cam.tz -= fx * mv; }
        if (on('right')) { cam.tx -= fz * mv; cam.tz += fx * mv; }
        if (on('fwd') || on('back') || on('left') || on('right')) {
          const g = groundY(cam.tx, cam.tz); // keep the pivot near the ground as it moves
          if (g != null) cam.ty += (g - cam.ty) * Math.min(1, dt * 4);
        }
        if (on('rotl')) cam.heading += 1.1 * dt * fast;
        if (on('rotr')) cam.heading -= 1.1 * dt * fast;
        if (on('tup')) cam.tilt += 0.8 * dt * fast;
        if (on('tdn')) cam.tilt -= 0.8 * dt * fast;
        if (on('zin')) cam.dist *= Math.exp(-1.4 * dt * fast);
        if (on('zout')) cam.dist *= Math.exp(1.4 * dt * fast);
        clampCam();
      }
      needle.style.transform = `rotate(${-cam.heading}rad)`;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
      const cw = Math.round(cssW * dpr), ch = Math.round(cssH * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      gl.viewport(0, 0, cw, ch);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const bs = basis(), eye = bs.eye;
      const view = mat4LookAt(eye, [cam.tx, cam.ty, cam.tz], bs.up);
      const near = Math.max(0.5, Math.min(cam.dist * 0.01, extent / 500));
      const proj = mat4Perspective(FOV, cw / Math.max(1, ch), near, cam.dist * 3 + extent * 4);
      const mvp = mat4Mul(proj, view);
      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.uniform1f(uZ, zScale); gl.uniform1f(uNScale, zScale); gl.uniform3fv(uEye, eye); gl.uniform1f(uFog, Math.max(extent * 2.5, cam.dist * 3));
      const az = sunAz * Math.PI / 180, alt = 45 * Math.PI / 180;
      gl.uniform3f(uSun, Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
      gl.uniform1f(uContourOn, contourOn ? 1 : 0);
      gl.uniform1f(uContourInterval, contourIntervalFt);
      gl.uniform3fv(uContourColor, CONTOUR_COLOR);
      gl.uniform1f(uHeatOn, heatOn ? 1 : 0);
      gl.uniform1f(uHeatOpacity, heatOpacityVal);

      // Terrain
      gl.uniform1f(uFlat, 0); gl.uniform1f(uPt, 1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texNrm);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, useImg && texImg ? texImg : texAlb);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texHeat);
      gl.uniform1f(uImg, useImg && texImg ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bUv); gl.enableVertexAttribArray(aUv); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
      gl.drawElements(gl.TRIANGLES, nIdx, idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);

      // Cave pins
      if (mkGroups.length) {
        gl.disableVertexAttribArray(aUv);
        gl.bindBuffer(gl.ARRAY_BUFFER, bMk);
        gl.uniform1f(uFlat, 1);
        for (const grp of mkGroups) {
          gl.uniform3f(uFlatColor, grp.rgb[0], grp.rgb[1], grp.rgb[2]);
          gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
          gl.uniform1f(uPt, 1);
          gl.drawArrays(gl.LINES, grp.start * 2, grp.count * 2);
          gl.uniform1f(uPt, 11 * dpr);
          gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 12); // just the top of each stalk
          gl.drawArrays(gl.POINTS, grp.start, grp.count);
        }
      }

      // Cave names, placed just above each pin's dot
      const showNames = namesBox.checked;
      for (const p of labeled) {
        const vx = p.x, vy = (p.y + stalk) * zScale, vz = p.z;
        const cxp = mvp[0] * vx + mvp[4] * vy + mvp[8] * vz + mvp[12];
        const cyp = mvp[1] * vx + mvp[5] * vy + mvp[9] * vz + mvp[13];
        const cwp = mvp[3] * vx + mvp[7] * vy + mvp[11] * vz + mvp[15];
        const dist = Math.hypot(vx - eye[0], vy - eye[1], vz - eye[2]);
        if (!showNames || cwp <= 0 || dist > Math.max(extent * 1.2, cam.dist * 2.5)) { if (p.shown) { p.el.style.display = 'none'; p.shown = false; } continue; }
        const sx = (cxp / cwp * 0.5 + 0.5) * cssW, sy = (1 - (cyp / cwp * 0.5 + 0.5)) * cssH;
        if (sx < -200 || sx > cssW + 50 || sy < -20 || sy > cssH + 20) { if (p.shown) { p.el.style.display = 'none'; p.shown = false; } continue; }
        if (!p.shown) { p.el.style.display = 'block'; p.shown = true; }
        p.el.style.transform = `translate(${Math.round(sx + 8)}px, ${Math.round(sy - 18)}px)`;
      }

      // Contour elevation labels - same screen-projection as cave names
      // above, just centred on the point rather than offset beside it.
      if (contourOn) {
        for (const p of contourLabelPoints) {
          const vx = p.x, vy = p.y * zScale, vz = p.z;
          const cxp = mvp[0] * vx + mvp[4] * vy + mvp[8] * vz + mvp[12];
          const cyp = mvp[1] * vx + mvp[5] * vy + mvp[9] * vz + mvp[13];
          const cwp = mvp[3] * vx + mvp[7] * vy + mvp[11] * vz + mvp[15];
          const dist = Math.hypot(vx - eye[0], vy - eye[1], vz - eye[2]);
          if (cwp <= 0 || dist > Math.max(extent * 1.2, cam.dist * 2.5)) { if (p.shown) { p.el.style.display = 'none'; p.shown = false; } continue; }
          const sx = (cxp / cwp * 0.5 + 0.5) * cssW, sy = (1 - (cyp / cwp * 0.5 + 0.5)) * cssH;
          if (sx < -40 || sx > cssW + 40 || sy < -20 || sy > cssH + 20) { if (p.shown) { p.el.style.display = 'none'; p.shown = false; } continue; }
          if (!p.shown) { p.el.style.display = 'block'; p.shown = true; }
          p.el.style.transform = `translate(${Math.round(sx - 14)}px, ${Math.round(sy - 7)}px)`;
        }
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      dispose() {
        cancelAnimationFrame(raf);
        window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext(); // free the GPU memory right away
      }
    };
  }

  // ---------- Leaflet control: whole view, or drag a box ----------
  function attachControl(map, options) {
    if (typeof L === 'undefined' || !map) return null;
    const getMarkers = (options && options.getMarkers) || (() => []);
    const getBasemaps = (options && options.getBasemaps) || (() => []);
    let menu = null, drawing = null, boxLayer = null;

    function boundsOf(llb) {
      return { n: llb.getNorth(), s: llb.getSouth(), e: llb.getEast(), w: llb.getWest() };
    }
    function clearBox() { if (boxLayer) { map.removeLayer(boxLayer); boxLayer = null; } }
    function launch(llb) {
      hideMenu();
      open({ bounds: boundsOf(llb), markers: getMarkers(), basemaps: getBasemaps(), onClose: clearBox });
    }

    // The site stylesheet styles every <button> (white text etc.), so the
    // menu's buttons get their own, more specific rules.
    if (!document.getElementById('terrain3d-style')) {
      const st = document.createElement('style');
      st.id = 'terrain3d-style';
      st.textContent = `
        .terrain3d-control .t3d-opt {
          display: block; width: 100%; margin: 0 0 6px; padding: 8px 10px;
          border: 1px solid #94a3b8; border-radius: 4px; background: #f1f5f9;
          color: #0f172a; font: 600 13px system-ui, sans-serif; text-align: left; cursor: pointer;
        }
        .terrain3d-control .t3d-opt:hover, .terrain3d-control .t3d-opt:focus-visible {
          background: #1e3a5f; border-color: #1e3a5f; color: #ffffff;
        }`;
      document.head.appendChild(st);
    }

    const Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const wrap = L.DomUtil.create('div', 'leaflet-bar leaflet-control terrain3d-control');
        wrap.style.cssText = 'position:relative;background:#fff;';
        const btn = L.DomUtil.create('a', '', wrap);
        btn.href = '#'; btn.title = '3D terrain view'; btn.textContent = '3D';
        btn.setAttribute('role', 'button');
        btn.style.cssText = 'font-weight:700;font-size:13px;width:34px;height:34px;line-height:34px;text-align:center;color:#1e3a5f;';
        menu = L.DomUtil.create('div', '', wrap);
        menu.style.cssText = 'display:none;position:absolute;left:40px;top:0;background:#fff;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.3);padding:8px;width:210px;font:13px system-ui,sans-serif;color:#1f2937;';
        menu.innerHTML = `
          <div style="font-weight:700;margin-bottom:6px;">3D terrain view</div>
          <button type="button" data-act="view" class="t3d-opt">Entire map view</button>
          <button type="button" data-act="box" class="t3d-opt">Select a bounding box</button>
          <div style="font-size:11px;color:#64748b;line-height:1.35;">Uses USGS 3DEP bare-earth elevation (US only). Areas up to about 2 × 2 km load at full 1 m detail; larger areas are shown coarser.</div>`;
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);
        L.DomEvent.on(btn, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          if (drawing) { stopDrawing(); return; }
          menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        });
        menu.querySelector('[data-act="view"]').addEventListener('click', () => launch(map.getBounds()));
        menu.querySelector('[data-act="box"]').addEventListener('click', () => { hideMenu(); startDrawing(); });
        return wrap;
      }
    });
    function hideMenu() { if (menu) menu.style.display = 'none'; }

    // Box drawing: drag with mouse or finger. Map panning is paused meanwhile.
    function startDrawing() {
      clearBox();
      const container = map.getContainer();
      const hint = L.DomUtil.create('div', '', container);
      hint.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:rgba(15,23,42,0.88);color:#fff;padding:8px 12px;border-radius:6px;font:13px system-ui,sans-serif;pointer-events:auto;white-space:nowrap;';
      hint.innerHTML = 'Drag on the map to draw the 3D area. <a href="#" style="color:#93c5fd;margin-left:6px;">Cancel</a>';
      L.DomEvent.disableClickPropagation(hint);
      hint.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); stopDrawing(); });
      const wasDragging = map.dragging.enabled(), wasBoxZoom = map.boxZoom && map.boxZoom.enabled();
      map.dragging.disable(); if (map.boxZoom) map.boxZoom.disable();
      const oldCursor = container.style.cursor, oldTouch = container.style.touchAction;
      container.style.cursor = 'crosshair'; container.style.touchAction = 'none';

      let start = null, startPt = null, rect = null;
      const inControl = (t) => t && t.closest && (t.closest('.leaflet-control') || t === hint || hint.contains(t));
      const down = (e) => {
        if (inControl(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault(); e.stopPropagation();
        start = map.mouseEventToLatLng(e); startPt = { x: e.clientX, y: e.clientY };
        rect = L.rectangle(L.latLngBounds(start, start), { color: '#f97316', weight: 2, fillOpacity: 0.12, interactive: false }).addTo(map);
        try { container.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      };
      const move = (e) => { if (start) { e.preventDefault(); rect.setBounds(L.latLngBounds(start, map.mouseEventToLatLng(e))); } };
      const up = (e) => {
        if (!start) return;
        e.preventDefault(); e.stopPropagation();
        const llb = L.latLngBounds(start, map.mouseEventToLatLng(e));
        const tiny = Math.abs(e.clientX - startPt.x) < 8 || Math.abs(e.clientY - startPt.y) < 8;
        start = null;
        // Swallow the click that follows the drag so it doesn't reach the map
        const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 300);
        if (tiny) { map.removeLayer(rect); rect = null; return; } // too small: keep drawing
        const keep = rect; rect = null;
        stopDrawing();
        boxLayer = keep;
        launch(llb);
      };
      const key = (e) => { if (e.key === 'Escape') stopDrawing(); };
      container.addEventListener('pointerdown', down, true);
      container.addEventListener('pointermove', move, true);
      container.addEventListener('pointerup', up, true);
      window.addEventListener('keydown', key);
      drawing = () => {
        container.removeEventListener('pointerdown', down, true);
        container.removeEventListener('pointermove', move, true);
        container.removeEventListener('pointerup', up, true);
        window.removeEventListener('keydown', key);
        if (rect) map.removeLayer(rect);
        hint.remove();
        container.style.cursor = oldCursor; container.style.touchAction = oldTouch;
        if (wasDragging) map.dragging.enable();
        if (wasBoxZoom) map.boxZoom.enable();
      };
    }
    function stopDrawing() { if (drawing) { const d = drawing; drawing = null; d(); } }

    const control = new Control();
    map.addControl(control);
    map.on('click', hideMenu);
    return control;
  }

  window.Terrain3D = { open, attachControl };
})();
