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
 *     getMarkers: () => [{ lat, lng, color: '#rrggbb', label: 'Name' }, ...]
 *   });
 *   // or directly:
 *   Terrain3D.open({ bounds: { n, s, e, w }, markers: [...] });
 */
(function () {
  'use strict';

  const ELEVATION_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
  const CELL_BUDGET = 4e6;   // elevation cells downloaded per view (~16 MB as floats)
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
        const resp = await fetch(url, { signal });
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
            <div style="color:#cbd5e1;">Drag to look &middot; W/A/S/D or arrows to fly &middot; Q/E down/up &middot; Shift = fast &middot; wheel = forward/back &middot; Esc to close</div>
            <label style="display:block;margin-top:6px;">Vertical exaggeration
              <input data-exag type="range" min="1" max="20" step="0.5" value="3" style="vertical-align:middle;width:130px;">
              <span data-exag-val>3x</span></label>
            <label style="display:block;">Sun direction
              <input data-sun type="range" min="0" max="360" step="5" value="315" style="vertical-align:middle;width:130px;">
              <span data-sun-val>315&deg;</span></label>
            <label data-names-row style="display:block;"><input data-names type="checkbox" checked> Show cave names</label>
          </div>
        </div>
        <button data-close style="margin-left:auto;pointer-events:auto;padding:8px 14px;border:none;border-radius:6px;background:#f1f5f9;color:#0f172a;cursor:pointer;font-weight:600;">Close 3D view</button>
      </div>
      <div data-pad style="position:absolute;bottom:16px;right:16px;display:none;grid-template-columns:repeat(2,60px);gap:6px;">
        <button data-hold="fwd">Fwd</button><button data-hold="up">Up</button>
        <button data-hold="back">Back</button><button data-hold="down">Down</button>
      </div>`;
    overlay.querySelectorAll('[data-hold]').forEach(b => { b.style.cssText = 'margin:0;padding:10px 0;border:none;border-radius:6px;background:rgba(241,245,249,0.9);color:#0f172a;font-weight:600;touch-action:none;'; });
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
            renderer = startRenderer(overlay, q, grid, markers);
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
  function startRenderer(overlay, q, g, markers) {
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

    // ---- Mesh: up to 1024 x 1024 vertices ----
    const maxGrid = uintExt ? 1024 : 255;
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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
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

    // Cave-name labels (the MAX_LABELS pins nearest the middle of the box)
    const labelLayer = q('[data-labels]');
    const labeled = pins.filter(p => p.label).sort((a, b2) => Math.hypot(a.x, a.z) - Math.hypot(b2.x, b2.z)).slice(0, MAX_LABELS);
    for (const p of labeled) {
      p.el = el('div', 'position:absolute;left:0;top:0;white-space:nowrap;font-size:11px;padding:1px 5px;border-radius:3px;background:rgba(15,23,42,0.75);color:#f8fafc;display:none;will-change:transform;', p.label);
      labelLayer.appendChild(p.el);
    }
    const namesBox = q('[data-names]');
    if (!labeled.length) q('[data-names-row]').style.display = 'none';

    // ---- Shaders ----
    const vs = `attribute vec3 a_pos; attribute vec2 a_uv;
      uniform mat4 u_mvp; uniform float u_zScale; uniform vec3 u_eye; uniform float u_pointSize;
      varying vec2 v_uv; varying float v_dist;
      void main() {
        vec3 p = vec3(a_pos.x, a_pos.y * u_zScale, a_pos.z);
        gl_Position = u_mvp * vec4(p, 1.0);
        gl_PointSize = u_pointSize;
        v_uv = a_uv; v_dist = distance(p, u_eye);
      }`;
    const fs = `precision mediump float;
      varying vec2 v_uv; varying float v_dist;
      uniform sampler2D u_nrm; uniform sampler2D u_alb;
      uniform vec3 u_sun; uniform float u_nScale; uniform float u_flat; uniform vec3 u_flatColor; uniform float u_fogFar;
      void main() {
        if (u_flat > 0.5) { gl_FragColor = vec4(u_flatColor, 1.0); return; }
        vec3 n = texture2D(u_nrm, v_uv).xyz * 2.0 - 1.0;
        n = normalize(vec3(n.x * u_nScale, n.y, n.z * u_nScale)); // exaggeration steepens the normal
        vec3 alb = texture2D(u_alb, v_uv).rgb;
        float d = max(dot(n, u_sun), 0.0);
        float sky = 0.25 + 0.15 * n.y;
        vec3 c = alb * (sky + 0.75 * d);
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
      uFlat = uni('u_flat'), uFlatColor = uni('u_flatColor'), uFog = uni('u_fogFar'), uPt = uni('u_pointSize');
    gl.uniform1i(uni('u_nrm'), 0); gl.uniform1i(uni('u_alb'), 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.55, 0.62, 0.72, 1); // hazy sky, matching the fog

    // ---- Controls ----
    q('[data-controls]').style.display = 'block';
    q('[data-pad]').style.display = 'grid';
    const exagEl = q('[data-exag]'), sunEl = q('[data-sun]');
    exagEl.value = zScale; q('[data-exag-val]').textContent = zScale + 'x';
    exagEl.addEventListener('input', () => { zScale = parseFloat(exagEl.value); q('[data-exag-val]').textContent = zScale + 'x'; });
    let sunAz = 315;
    sunEl.addEventListener('input', () => { sunAz = parseFloat(sunEl.value); q('[data-sun-val]').textContent = sunAz + '°'; });

    // Start south of the box, looking north and down over it
    const cam = { x: 0, y: relief * zScale * 1.5 + extent * 0.35, z: cz * 1.3, yaw: 0, pitch: -0.55 };
    const held = new Set();
    let last = performance.now(), raf = 0, dragging = null;
    const keys = ['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'];
    const onKey = (e, down) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
      const key = e.key.toLowerCase();
      if (keys.includes(key)) { if (down) held.add(key); else held.delete(key); e.preventDefault(); }
    };
    const kd = (e) => onKey(e, true), ku = (e) => onKey(e, false);
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    canvas.addEventListener('pointerdown', (e) => { dragging = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      cam.yaw += (e.clientX - dragging.x) * 0.005;
      cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - (e.clientY - dragging.y) * 0.005));
      dragging = { x: e.clientX, y: e.clientY };
    });
    const endDrag = () => { dragging = null; };
    canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = -Math.sign(e.deltaY) * extent * 0.03;
      cam.x += Math.cos(cam.pitch) * Math.sin(cam.yaw) * d; cam.y += Math.sin(cam.pitch) * d; cam.z -= Math.cos(cam.pitch) * Math.cos(cam.yaw) * d;
    }, { passive: false });
    overlay.querySelectorAll('[data-hold]').forEach(btn => {
      const k2 = 'btn-' + btn.dataset.hold;
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); held.add(k2); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, () => held.delete(k2)));
    });

    function frame(now) {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const speed = extent * 0.12 * (held.has('shift') ? 4 : 1) * dt;
      const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
      if (held.has('w') || held.has('arrowup') || held.has('btn-fwd')) { cam.x += fx * speed; cam.z += fz * speed; cam.y += Math.sin(cam.pitch) * speed; }
      if (held.has('s') || held.has('arrowdown') || held.has('btn-back')) { cam.x -= fx * speed; cam.z -= fz * speed; cam.y -= Math.sin(cam.pitch) * speed; }
      if (held.has('a')) { cam.x += fz * speed; cam.z -= fx * speed; }
      if (held.has('d')) { cam.x -= fz * speed; cam.z += fx * speed; }
      if (held.has('arrowleft')) cam.yaw -= 1.2 * dt;
      if (held.has('arrowright')) cam.yaw += 1.2 * dt;
      if (held.has('q') || held.has('btn-down')) cam.y -= speed;
      if (held.has('e') || held.has('btn-up')) cam.y += speed;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
      const cw = Math.round(cssW * dpr), ch = Math.round(cssH * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      gl.viewport(0, 0, cw, ch);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const eye = [cam.x, cam.y, cam.z];
      const dir = [Math.cos(cam.pitch) * Math.sin(cam.yaw), Math.sin(cam.pitch), -Math.cos(cam.pitch) * Math.cos(cam.yaw)];
      const view = mat4LookAt(eye, [eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]], [0, 1, 0]);
      const proj = mat4Perspective(Math.PI / 3, cw / Math.max(1, ch), Math.max(0.5, extent / 5000), extent * 6);
      const mvp = mat4Mul(proj, view);
      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.uniform1f(uZ, zScale); gl.uniform1f(uNScale, zScale); gl.uniform3fv(uEye, eye); gl.uniform1f(uFog, extent * 2.5);
      const az = sunAz * Math.PI / 180, alt = 45 * Math.PI / 180;
      gl.uniform3f(uSun, Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));

      // Terrain
      gl.uniform1f(uFlat, 0); gl.uniform1f(uPt, 1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texNrm);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texAlb);
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
        if (!showNames || cwp <= 0 || dist > extent * 1.2) { if (p.shown) { p.el.style.display = 'none'; p.shown = false; } continue; }
        const sx = (cxp / cwp * 0.5 + 0.5) * cssW, sy = (1 - (cyp / cwp * 0.5 + 0.5)) * cssH;
        if (sx < -200 || sx > cssW + 50 || sy < -20 || sy > cssH + 20) { if (p.shown) { p.el.style.display = 'none'; p.shown = false; } continue; }
        if (!p.shown) { p.el.style.display = 'block'; p.shown = true; }
        p.el.style.transform = `translate(${Math.round(sx + 8)}px, ${Math.round(sy - 18)}px)`;
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
    let menu = null, drawing = null, boxLayer = null;

    function boundsOf(llb) {
      return { n: llb.getNorth(), s: llb.getSouth(), e: llb.getEast(), w: llb.getWest() };
    }
    function clearBox() { if (boxLayer) { map.removeLayer(boxLayer); boxLayer = null; } }
    function launch(llb) {
      hideMenu();
      open({ bounds: boundsOf(llb), markers: getMarkers(), onClose: clearBox });
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
