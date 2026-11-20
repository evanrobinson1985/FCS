/*
 * Cave Profile: everything the site holds about one cave, on one page.
 *
 * Opened from a cave's name (or Profile button) in the Cave Database table,
 * the "Full Profile" button in a map marker's popup, or the search box on
 * the profile itself. Data comes from GET /api/caves/:id/profile (server.js);
 * the tabs that own each kind of data (Edit Cave Data, Narrative, Cave Maps,
 * the Interactive Map, the submission queues) are unchanged and linked from
 * here.
 *
 * Code letters (entry status "K", geology "OC"...) are shown with the
 * wording of the Edit Cave Data form's own options, so both always match.
 *
 * Everything from the server is inserted as text or escaped; narrative HTML
 * is already cleaned by the server (the same rules the Narrative tab uses).
 */
(function () {
  'use strict';

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const auth = (url) => (typeof window.withAuthToken === 'function' ? window.withAuthToken(url) : url);
  const role = () => sessionStorage.getItem('role') || localStorage.getItem('role') || '';
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((n || 0) / 1024)) + ' KB');
  const pick = (cave, ...keys) => { for (const k of keys) { const v = cave[k]; if (v !== undefined && v !== null && v !== '') return v; } return ''; };
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  // "K" -> "K - Government park", using the Edit Cave Data form's options
  function label(selectId, code) {
    if (code === '' || code == null) return '';
    const sel = document.getElementById(selectId);
    const opt = sel && [...sel.options].find((o) => o.value === String(code));
    return opt && opt.textContent.trim() ? opt.textContent.trim() : String(code);
  }
  function checkboxLabel(prefix, code) {
    const lab = document.querySelector(`label[for="${prefix}${code}"]`);
    return lab ? lab.textContent.trim() : code;
  }
  function codeList(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean);
    return [];
  }

  let previousTab = null;
  let current = null;

  function injectStyles() {
    if (document.getElementById('cp-styles')) return;
    const st = document.createElement('style');
    st.id = 'cp-styles';
    st.textContent = `
      #cave-profile { padding: 0 !important; }
      .cp-band { background: #2a4d69; color: #fff; padding: 14px 18px 16px; border-radius: 8px 8px 0 0; }
      .cp-top { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; }
      .cp-top button.cp-back { background: transparent; border: 1px solid rgba(255,255,255,.55); color: #fff; border-radius: 5px; padding: 4px 10px; cursor: pointer; font: inherit; }
      .cp-find { margin-left: auto; position: relative; }
      .cp-find input { width: min(280px, 62vw); padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.45); background: rgba(255,255,255,.14); color: #fff; font: inherit; font-size: 13px; }
      .cp-find input::placeholder { color: rgba(255,255,255,.8); }
      .cp-suggest { position: absolute; right: 0; top: 100%; margin-top: 4px; width: 300px; max-width: 80vw; list-style: none; padding: 4px; background: #fff; color: #222; border: 1px solid #d5dde3; border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.2); z-index: 50; max-height: 320px; overflow: auto; }
      .cp-suggest li { padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 13px; }
      .cp-suggest li:hover, .cp-suggest li.on { background: #e6eff7; }
      .cp-title { display: flex; gap: 12px 22px; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; margin-top: 12px; }
      .cp-id { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 13px; letter-spacing: .04em; background: rgba(255,255,255,.15); padding: 2px 8px; border-radius: 4px; }
      .cp-title h2 { color: #fff; font-size: clamp(22px, 3.6vw, 30px); margin: 6px 0 2px; text-wrap: balance; }
      .cp-facts { display: flex; gap: 4px 14px; flex-wrap: wrap; font-size: 14px; opacity: .92; }
      .cp-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .cp-actions button { font: inherit; font-size: 13.5px; font-weight: 600; padding: 7px 12px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(255,255,255,.55); background: transparent; color: #fff; }
      .cp-actions button.primary { background: #fff; color: #2a4d69; border-color: #fff; }
      .cp-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
      .cp-badge { font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,.16); color: #fff; }
      .cp-badge.hz { background: #c8641c; }
      .cp-nav { position: sticky; top: 0; z-index: 30; display: flex; gap: 2px; overflow-x: auto; background: #fff; border-bottom: 1px solid #dfe5ea; padding: 0 10px; scrollbar-width: none; }
      .cp-nav a { color: #5b6b78; text-decoration: none; font-size: 14px; font-weight: 600; padding: 10px 11px; border-bottom: 3px solid transparent; white-space: nowrap; }
      .cp-nav a.on { color: #2f6f9f; border-bottom-color: #4b86b4; }
      .cp-nav .n { font-size: 11px; background: #f1f4f7; border: 1px solid #dfe5ea; color: #5b6b78; border-radius: 999px; padding: 0 6px; margin-left: 4px; }
      .cp-body { padding: 16px 18px 26px; display: grid; gap: 16px; }
      .cp-card { background: #fff; border: 1px solid #dfe5ea; border-radius: 8px; padding: 14px 16px; scroll-margin-top: 50px; min-width: 0; }
      .cp-card h3 { font-size: 17px; margin: 0; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
      .cp-card h3 .sub { font-size: 13px; font-weight: 400; color: #5b6b78; }
      .cp-from { font-size: 12px; color: #5b6b78; margin: 2px 0 12px; }
      .cp-from a { color: #2f6f9f; cursor: pointer; }
      .cp-two { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr); gap: 16px; }
      @media (max-width: 780px) { .cp-two { grid-template-columns: 1fr; } }
      .cp-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 0; font-size: 14px; }
      .cp-kv dt { color: #5b6b78; }
      .cp-kv dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
      .cp-mono { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 13px; }
      .cp-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
      .cp-stat { background: #f4f7fa; border: 1px solid #dfe5ea; border-radius: 6px; padding: 9px 12px; }
      .cp-stat .k { font-size: 11.5px; color: #5b6b78; text-transform: uppercase; letter-spacing: .05em; }
      .cp-stat .v { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .cp-stat .v small { font-size: 13px; font-weight: 400; color: #5b6b78; }
      .cp-codes { display: flex; gap: 6px; flex-wrap: wrap; }
      .cp-code { font-size: 12.5px; border: 1px solid #dfe5ea; background: #f4f7fa; border-radius: 4px; padding: 2px 7px; }
      .cp-tbl { overflow-x: auto; border: 1px solid #dfe5ea; border-radius: 6px; }
      .cp-tbl table { border-collapse: collapse; width: 100%; font-size: 13.5px; min-width: 520px; }
      .cp-tbl th, .cp-tbl td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e7ecf0; }
      .cp-tbl th { background: #f4f7fa; color: #5b6b78; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
      .cp-hist { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; font-size: 13.5px; }
      .cp-hist li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; }
      .cp-hist time { color: #5b6b78; }
      .cp-narr { border-top: 1px solid #e7ecf0; padding-top: 12px; margin-top: 12px; }
      .cp-narr:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
      .cp-narr-meta { font-size: 12.5px; color: #5b6b78; }
      .cp-narr-text { max-width: 78ch; margin-top: 6px; overflow-wrap: anywhere; }
      .cp-narr-text img { max-width: 100%; height: auto; }
      .cp-narr-text p { margin: 0 0 .7em; }
      .cp-narr-text p:last-child { margin-bottom: 0; }
      .cp-narr-text.clamped { max-height: 9.5em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
      .cp-photos { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .cp-photos a { display: block; width: 132px; aspect-ratio: 4/3; border-radius: 5px; overflow: hidden; border: 1px solid #dfe5ea; background: #eef2f5; }
      .cp-photos img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .cp-note { font-size: 13px; color: #7a4a00; background: #fdf0dc; border-radius: 5px; padding: 6px 10px; margin-top: 8px; }
      .cp-link { background: none; border: 0; padding: 0; color: #2f6f9f; font: inherit; font-weight: 600; cursor: pointer; }
      .cp-files { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
      .cp-file { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 12px; align-items: center; border: 1px solid #dfe5ea; border-radius: 6px; padding: 10px 12px; }
      .cp-file.possible { background: #fff8ec; }
      @media (max-width: 600px) { .cp-file { grid-template-columns: 44px minmax(0, 1fr); } .cp-file .acts { grid-column: 1 / -1; } }
      .cp-ficon { width: 44px; height: 44px; border-radius: 6px; display: grid; place-items: center; font: 700 10.5px ui-monospace, Consolas, monospace; color: #fff; }
      .cp-ficon.geotiff { background: #3f7d5a; } .cp-ficon.shapefile { background: #6b5aa8; } .cp-ficon.scan { background: #a8513b; }
      .cp-fname { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
      .cp-fmeta { font-size: 12.5px; color: #5b6b78; }
      .cp-ok { color: #2e7d32; font-weight: 600; } .cp-maybe { color: #9a5b00; font-weight: 600; }
      .cp-file .acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .cp-file .acts button, .cp-file .acts a { font: inherit; font-size: 12.5px; font-weight: 600; padding: 4px 10px; border-radius: 5px; border: 1px solid #d5dde3; background: #fff; color: #26323b; cursor: pointer; text-decoration: none; }
      .cp-feed { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
      .cp-feed li { display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 10px; }
      .cp-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; background: #4b86b4; }
      .cp-dot.pending { background: #d68910; } .cp-dot.approved { background: #2e7d32; } .cp-dot.rejected { background: #b3261e; } .cp-dot.move { background: #c8641c; }
      .cp-feed .m { font-size: 12.5px; color: #5b6b78; }
      .cp-pill { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; margin-left: 6px; }
      .cp-pill.pending { background: #fdf0dc; color: #9a5b00; } .cp-pill.approved { background: #e5f3e6; color: #2e7d32; } .cp-pill.rejected { background: #fbe9e7; color: #b3261e; }
      .cp-empty { color: #5b6b78; font-style: italic; margin: 0; }
      #cave-profile button:focus-visible, #cave-profile a:focus-visible, #cave-profile input:focus-visible { outline: 2px solid #4b86b4; outline-offset: 2px; }
    `;
    document.head.appendChild(st);
  }

  // ---- showing the profile ----
  function showPanel() {
    const panel = document.getElementById('cave-profile');
    const active = document.querySelector('.tab.active');
    if (active && active.dataset.tab !== 'cave-profile') previousTab = active.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    panel.classList.add('active');
    panel.scrollIntoView({ block: 'start' });
    return panel;
  }

  async function openCaveProfile(caveId) {
    if (window.__caveProfileHidden) { alert('Cave profiles are temporarily unavailable.'); return; }
    injectStyles();
    const panel = showPanel();
    panel.innerHTML = '<div class="cp-body"><p>Loading cave profile…</p></div>';
    try {
      const response = await fetch(`/api/caves/${encodeURIComponent(caveId)}/profile`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load this cave');
      current = data;
      render(panel, data);
    } catch (err) {
      panel.innerHTML = '';
      const body = document.createElement('div');
      body.className = 'cp-body';
      body.textContent = 'Could not open the cave profile: ' + err.message;
      panel.appendChild(body);
    }
  }

  function goBack() {
    const tab = document.querySelector(`.tab[data-tab="${previousTab || 'cave-database'}"]`) || document.querySelector('.tab');
    if (tab) tab.click();
  }

  function render(panel, data) {
    const cave = data.cave;
    const narratives = data.narratives || [];
    const maps = data.maps || [];
    const linked = maps.filter((m) => m.link === 'linked');
    const possible = maps.filter((m) => m.link === 'possible');
    const photoCount = narratives.reduce((n, x) => n + (x.images || []).length, 0);
    const hz = cave.hazards || {};
    const hazards = [
      hz.badAir && 'Bad Air', hz.unstable && 'Unstable Structure', hz.casualties && 'Known Casualties', hz.histoplasmosis && 'Histoplasmosis',
    ].filter(Boolean);
    const entrances = Array.isArray(cave.entrances) ? cave.entrances : [];
    const activityCount = (data.submissions ? data.submissions.length : 0) + (cave.locationHistory || []).length;
    const county = (window.getCountyName && cave.county) ? window.getCountyName('FL', cave.county) : (cave.county || '');
    const lat = num(pick(cave, 'latitude', 'lat'));
    const lng = num(pick(cave, 'longitude', 'lng'));
    const type = String(cave.type || '').toLowerCase().includes('underwater') ? 'Underwater cave' : 'Land cave';

    panel.innerHTML = `
      <div class="cp-band">
        <div class="cp-top">
          <button type="button" class="cp-back" data-cp="back">← Back</button>
          <span>Cave Profile</span>
          <form class="cp-find" data-cp="find" role="search" autocomplete="off">
            <input type="search" placeholder="Find another cave by name or ID…" aria-label="Find a cave" data-cp="find-input">
            <ul class="cp-suggest" role="listbox" hidden data-cp="suggest"></ul>
          </form>
        </div>
        <div class="cp-title">
          <div>
            <span class="cp-id">${esc(cave.id)}</span>
            <h2>${esc(cave.name || 'Unnamed cave')}</h2>
            <div class="cp-facts">
              <span>${esc(type)}</span>
              ${county ? `<span>${esc(county)} County, FL</span>` : ''}
              ${cave.entryStatus ? `<span>${esc(label('edit-entry-status', cave.entryStatus))}</span>` : ''}
              <span>${entrances.length > 1 ? `${entrances.length} entrances` : '1 entrance'}</span>
            </div>
          </div>
          <div class="cp-actions">
            <button type="button" class="primary" data-cp="map">View on Map</button>
            <button type="button" data-cp="edit">Edit</button>
            <button type="button" data-cp="narrate">Add Narrative</button>
            <button type="button" data-cp="download">Download</button>
          </div>
        </div>
        <div class="cp-badges">
          ${hazards.map((h) => `<span class="cp-badge hz">⚠ ${esc(h)}</span>`).join('')}
          ${cave.mapStatus ? `<span class="cp-badge">Map: ${esc(label('edit-map-status', cave.mapStatus))}</span>` : ''}
          ${codeList(cave.exploration).length ? `<span class="cp-badge">Exploration: ${esc(codeList(cave.exploration).join(', '))}</span>` : ''}
        </div>
      </div>
      <nav class="cp-nav" aria-label="Cave profile sections">
        <a href="#cp-overview" class="on">Overview</a>
        <a href="#cp-location">Location</a>
        <a href="#cp-survey">Survey Details</a>
        <a href="#cp-narratives">Narratives &amp; Photos<span class="n">${narratives.length}</span></a>
        <a href="#cp-maps">Maps &amp; GIS<span class="n">${maps.length}</span></a>
        ${data.submissions ? `<a href="#cp-activity">Activity<span class="n">${activityCount}</span></a>` : ''}
      </nav>
      <div class="cp-body">
        ${overviewHtml(cave, narratives, photoCount, linked, possible, hz)}
        ${locationHtml(cave, lat, lng)}
        ${surveyHtml(cave, entrances)}
        ${narrativesHtml(narratives, data.largeFilesDisabled)}
        ${mapsHtml(maps, data)}
        ${data.submissions ? activityHtml(cave, data.submissions) : ''}
      </div>`;
    wire(panel, data, lat, lng);
  }

  function overviewHtml(cave, narratives, photoCount, linked, possible, hz) {
    const len = pick(cave, 'caveLength', 'length');
    const vert = pick(cave, 'verticalExtent', 'vertical');
    return `
      <section class="cp-card" id="cp-overview">
        <h3>Overview <span class="sub">Everything the site holds for this cave</span></h3>
        <p class="cp-from">From the cave record, narratives, cave maps${current && current.submissions ? ' and submissions' : ''}.</p>
        <div class="cp-stats">
          <div class="cp-stat"><div class="k">Horizontal length</div><div class="v">${len !== '' ? `${esc(len)} <small>ft</small>` : '<small>not recorded</small>'}</div></div>
          <div class="cp-stat"><div class="k">Vertical extent</div><div class="v">${vert !== '' ? `${esc(vert)} <small>ft</small>` : '<small>not recorded</small>'}</div></div>
          <div class="cp-stat"><div class="k">Narratives</div><div class="v">${narratives.length} <small>· ${photoCount} photo${photoCount === 1 ? '' : 's'}</small></div></div>
          <div class="cp-stat"><div class="k">Maps &amp; GIS files</div><div class="v">${linked.length} <small>${possible.length ? `· ${possible.length} possible` : ''}</small></div></div>
        </div>
        ${hz.notes ? `<p style="margin: 12px 0 0; max-width: 78ch;"><strong>Hazard notes:</strong> ${esc(hz.notes)}</p>` : ''}
        ${cave.notes ? `<p style="margin: 8px 0 0; max-width: 78ch;"><strong>Notes:</strong> ${esc(cave.notes)}</p>` : ''}
      </section>`;
  }

  function locationHtml(cave, lat, lng) {
    const rows = [
      ['Latitude', lat !== null ? `<span class="cp-mono">${esc(lat.toFixed(6))}</span>` : ''],
      ['Longitude', lng !== null ? `<span class="cp-mono">${esc(lng.toFixed(6))}</span>` : ''],
      ['Accuracy', esc(label('edit-location-accuracy', cave.locationAccuracy))],
      ['Elevation', pick(cave, 'elevation') !== '' ? `${esc(pick(cave, 'elevation'))} ft` : ''],
      ['USGS quad', esc(pick(cave, 'usgsQuad'))],
      ['Township / Range / Section', esc([pick(cave, 'township'), pick(cave, 'range'), pick(cave, 'section') && `Sec ${pick(cave, 'section')}`, pick(cave, 'sectionPart')].filter(Boolean).join(' '))],
      ['Topographic province', esc(label('edit-topo-province', pick(cave, 'topoProvince', 'topographicProvince')))],
    ].filter(([, v]) => v);
    const history = (cave.locationHistory || []).slice().reverse();
    return `
      <section class="cp-card" id="cp-location">
        <h3>Location</h3>
        <p class="cp-from">From the cave record · <a data-cp="edit">Edit Cave Data</a> · <a data-cp="map">Interactive Map</a></p>
        <dl class="cp-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
        <h4 style="margin: 14px 0 0; font-size: 14px;">Location history</h4>
        ${history.length ? `<ul class="cp-hist">${history.map((h) => `
          <li><time>${esc(fmtDate(h.at))}</time><span>${esc(h.from ? `${h.from.lat}, ${h.from.lng}` : '(none)')} → ${esc(h.to ? `${h.to.lat}, ${h.to.lng}` : '')}
            · ${esc(h.via || 'changed')}${h.requestedBy ? `, asked by <b>${esc(h.requestedBy)}</b>` : ''}${h.approvedBy && h.approvedBy !== h.requestedBy ? `, approved by <b>${esc(h.approvedBy)}</b>` : ''}</span></li>`).join('')}</ul>`
          : '<p class="cp-empty" style="margin-top: 6px;">No moves recorded. (Moves are recorded from Nov 2026 on.)</p>'}
      </section>`;
  }

  function surveyHtml(cave, entrances) {
    const rows = [
      ['Entrance type', label('edit-entrance-type', cave.entranceType)],
      ['Field indication', label('edit-field-indication', cave.fieldIndication)],
      ['Entry status', label('edit-entry-status', cave.entryStatus)],
      ['Owner', pick(cave, 'ownerInfo', 'ownerEntityInfo')],
      ['Geology', label('edit-geology', pick(cave, 'geology', 'geologicFormation'))],
      ['Map type', label('edit-map-type', cave.mapType)],
      ['Map status', label('edit-map-status', cave.mapStatus)],
    ].filter(([, v]) => v);
    const dims = [
      ['Length', pick(cave, 'caveLength', 'length')], ['Vertical extent', pick(cave, 'verticalExtent', 'vertical')],
      ['Max water depth', pick(cave, 'maxWaterDepth', 'waterDepth', 'water')], ['Deepest pitch', pick(cave, 'deepestPitch', 'pitch')],
    ].filter(([, v]) => v !== '').map(([k, v]) => [k, `${v} ft`]);
    const reporter = [pick(cave, 'reporterName'), pick(cave, 'reporterNSS', 'reporter') && `NSS ${pick(cave, 'reporterNSS', 'reporter')}`].filter(Boolean).join(' · ');
    const more = [
      ['Reporter', reporter],
      ['Added', [fmtDate(cave.createdDate), cave.createdBy && `by ${cave.createdBy}`].filter(Boolean).join(' ')],
      ['Last updated', [fmtDate(cave.lastUpdated), cave.updatedBy && `by ${cave.updatedBy}`].filter(Boolean).join(' ')],
    ].filter(([, v]) => v);
    const kv = (list) => `<dl class="cp-kv">${list.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    const equipment = codeList(cave.equipment);
    const exploration = codeList(cave.exploration);
    return `
      <section class="cp-card" id="cp-survey">
        <h3>Survey Details</h3>
        <p class="cp-from">From the cave record · <a data-cp="edit">Edit Cave Data</a></p>
        <div class="cp-two">${kv(rows)}${kv([...dims, ...more])}</div>
        ${equipment.length ? `<h4 style="margin: 14px 0 6px; font-size: 14px;">Equipment needed</h4><div class="cp-codes">${equipment.map((c) => `<span class="cp-code">${esc(checkboxLabel('edit-equipment-', c))}</span>`).join('')}</div>` : ''}
        ${exploration.length ? `<h4 style="margin: 12px 0 6px; font-size: 14px;">Exploration possibilities</h4><div class="cp-codes">${exploration.map((c) => `<span class="cp-code">${esc(checkboxLabel('edit-exploration-', c))}</span>`).join('')}</div>` : ''}
        ${entrances.length ? `<h4 style="margin: 14px 0 6px; font-size: 14px;">Entrances</h4>
          <div class="cp-tbl"><table><thead><tr><th>Entrance</th><th>Type</th><th>Status</th><th>Latitude</th><th>Longitude</th><th>Elev.</th></tr></thead><tbody>
          ${entrances.map((e, i) => `<tr><td>${esc(e.name || `Entrance ${i + 1}`)}</td><td>${esc(label('edit-entrance-type', e.entranceType))}</td><td>${esc(e.entryStatus || '')}</td>
            <td class="cp-mono">${esc(num(e.latitude) !== null ? num(e.latitude).toFixed(6) : '')}</td><td class="cp-mono">${esc(num(e.longitude) !== null ? num(e.longitude).toFixed(6) : '')}</td><td>${esc(e.elevation ? `${e.elevation} ft` : '')}</td></tr>`).join('')}
          </tbody></table></div>` : ''}
      </section>`;
  }

  function narrativesHtml(narratives, largeFilesDisabled) {
    const items = narratives.map((n, i) => {
      const photos = n.images || [];
      return `
        <article class="cp-narr">
          <div class="cp-narr-meta">by <b>${esc(n.user || 'unknown')}</b> · ${esc(fmtDate(n.lastModified || n.timestamp))}${photos.length ? ` · ${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''}</div>
          <div class="cp-narr-text clamped" data-cp-narr="${i}">${n.html || ''}</div>
          <button type="button" class="cp-link" data-cp="expand" data-i="${i}">Read more</button>
          ${photos.length ? (largeFilesDisabled
            ? '<div class="cp-note">Photos are temporarily unavailable while large file transfers are turned off.</div>'
            : `<div class="cp-photos">${photos.map((p) => `<a href="${esc(auth(p.url))}" target="_blank" rel="noopener" title="${esc(p.caption)}"><img src="${esc(auth(p.url))}" alt="${esc(p.caption || 'Narrative photo')}" loading="lazy"></a>`).join('')}</div>`) : ''}
        </article>`;
    }).join('');
    return `
      <section class="cp-card" id="cp-narratives">
        <h3>Narratives &amp; Photos <span class="sub">${narratives.length ? `${narratives.length} trip report${narratives.length === 1 ? '' : 's'}, newest first` : ''}</span></h3>
        <p class="cp-from">From the Narrative tab · <a data-cp="narrate">Open in Narrative</a></p>
        ${items || '<p class="cp-empty">No narratives yet. Use “Add Narrative” to write the first trip report.</p>'}
      </section>`;
  }

  function mapsHtml(maps, data) {
    const kindLabel = { geotiff: 'Georeferenced GeoTIFF', shapefile: 'Shapefile', scan: 'Scanned map (Cave Maps collection)' };
    const icon = { geotiff: 'TIF', shapefile: 'SHP', scan: 'MAP' };
    const items = maps.map((m, i) => {
      const status = m.link === 'linked'
        ? '<span class="cp-ok">Linked to this cave</span>'
        : '<span class="cp-maybe">Possible match</span>: its file name mentions this cave';
      const acts = [];
      if (!data.largeFilesDisabled) {
        if (m.kind === 'scan') acts.push(`<button type="button" data-cp="preview" data-i="${i}">Preview</button>`);
        else acts.push(`<button type="button" data-cp="overlay" data-i="${i}">Show on map</button>`);
        acts.push(`<a href="${esc(auth(m.url))}" download>Download</a>`);
      }
      if (data.canManageLinks) {
        if (m.link === 'possible') acts.push(`<button type="button" data-cp="link" data-i="${i}">Confirm link</button>`, `<button type="button" data-cp="dismiss" data-i="${i}">Not this cave</button>`);
        else acts.push(`<button type="button" data-cp="unlink" data-i="${i}">Unlink</button>`);
      }
      return `
        <li class="cp-file ${m.link === 'possible' ? 'possible' : ''}">
          <div class="cp-ficon ${esc(m.kind)}" aria-hidden="true">${icon[m.kind] || 'MAP'}</div>
          <div><div class="cp-fname">${esc(m.filename)}</div><div class="cp-fmeta">${esc(kindLabel[m.kind] || m.kind)} · ${esc(fmtSize(m.size))} · ${status}</div></div>
          <div class="acts">${acts.join('')}</div>
        </li>`;
    }).join('');
    return `
      <section class="cp-card" id="cp-maps">
        <h3>Maps &amp; GIS <span class="sub">Cave maps, georeferenced images and shapefiles</span></h3>
        <p class="cp-from">From Cave Maps and the uploaded cave map files · <a data-cp="cavemaps">Open Cave Maps</a></p>
        ${data.largeFilesDisabled && maps.length ? '<div class="cp-note" style="margin-bottom: 10px;">Viewing and downloading map files is temporarily unavailable while large file transfers are turned off.</div>' : ''}
        ${items ? `<ul class="cp-files">${items}</ul>` : `<p class="cp-empty">No map files linked to this cave yet.${data.canManageLinks ? ' Upload maps on the Interactive Map tab with this cave\'s ID to link them.' : ''}</p>`}
      </section>`;
  }

  function activityHtml(cave, submissions) {
    const items = [];
    for (const s of submissions) {
      const what = s.type === 'new_cave' ? 'New cave proposal' : s.isMove ? 'Move request' : 'Edit proposal';
      const decided = s.status === 'approved' ? ` · approved by ${s.approvedBy || '?'} ${fmtDate(s.approvedDate)}`
        : s.status === 'rejected' ? ` · rejected by ${s.rejectedBy || '?'} ${fmtDate(s.rejectedDate)}` : '';
      items.push({ at: s.submittedAt, html: `
        <li><span class="cp-dot ${esc(s.isMove ? 'move' : s.status)}" aria-hidden="true"></span><div>
          <div>${esc(what)}${s.changed.length && s.type !== 'new_cave' ? `: ${esc(s.changed.join(', '))}` : ''}<span class="cp-pill ${esc(s.status)}">${esc(s.status)}</span></div>
          <div class="m">by ${esc(s.submittedBy)} · ${esc(fmtDate(s.submittedAt))}${esc(decided)}${s.status === 'pending' ? ' · <button type="button" class="cp-link" data-cp="review">Review</button>' : ''}</div>
        </div></li>` });
    }
    if (cave.lastUpdated) {
      items.push({ at: cave.lastUpdated, html: `<li><span class="cp-dot" aria-hidden="true"></span><div><div>Record last updated</div><div class="m">${esc(cave.updatedBy ? `by ${cave.updatedBy} · ` : '')}${esc(fmtDate(cave.lastUpdated))}</div></div></li>` });
    }
    items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return `
      <section class="cp-card" id="cp-activity">
        <h3>Activity <span class="sub">Submissions and changes for this cave (admins and webmasters)</span></h3>
        <p class="cp-from">From Pending and Approved Submissions · <a data-cp="review">Open Pending Submissions</a></p>
        ${items.length ? `<ul class="cp-feed">${items.map((x) => x.html).join('')}</ul>` : '<p class="cp-empty">No submissions for this cave.</p>'}
      </section>`;
  }

  // ---- actions ----
  function waitFor(test, tries = 60) {
    return new Promise((resolve) => {
      const tick = (n) => { const v = test(); if (v || n <= 0) resolve(v); else setTimeout(() => tick(n - 1), 100); };
      tick(tries);
    });
  }

  async function showOverlay(m) {
    document.querySelector('.tab[data-tab="map-tab"]').click();
    const select = await waitFor(() => { const s = document.getElementById('cave-maps-select'); return s && [...s.options].some((o) => o.value === m.overlayId) && s; });
    if (!select || typeof window.addSelectedCaveMap !== 'function') { alert('That map is not in the map overlay list. Open it from the Interactive Map tab.'); return; }
    select.value = m.overlayId;
    window.addSelectedCaveMap();
  }

  async function previewScan(m) {
    document.querySelector('.tab[data-tab="cave-maps-section"]').click();
    const dd = await waitFor(() => { const d = document.getElementById('cave-maps-dropdown'); return d && [...d.options].some((o) => o.value === m.filename) && d; });
    if (!dd) return;
    dd.value = m.filename;
    dd.dispatchEvent(new Event('change'));
  }

  async function addNarrative(id) {
    document.querySelector('.tab[data-tab="narrative-tab"]').click();
    const sel = await waitFor(() => { const s = document.getElementById('narrative-cave-select'); return s && [...s.options].some((o) => o.value === id) && s; });
    if (sel && typeof window.goToNarrative === 'function') window.goToNarrative(id);
  }

  function viewOnMap(cave, lat, lng) {
    document.querySelector('.tab[data-tab="map-tab"]').click();
    if (typeof window.focusOnCave === 'function' && lat !== null && lng !== null) window.focusOnCave(cave.id, lat, lng);
  }

  function htmlToText(html) {
    const d = document.createElement('div');
    d.innerHTML = String(html || '').replace(/<\/(p|div|h\d|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
    return d.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }
  function downloadProfile(data) {
    const c = data.cave;
    const lines = [];
    const add = (k, v) => { if (v !== '' && v != null) lines.push(`${k}: ${v}`); };
    lines.push(`FLORIDA CAVE SURVEY - CAVE PROFILE`, `${c.id} - ${c.name || ''}`, `Exported ${new Date().toLocaleString()}`, '');
    add('County', c.county); add('Type', c.type); add('Latitude', pick(c, 'latitude', 'lat')); add('Longitude', pick(c, 'longitude', 'lng'));
    add('Location accuracy', label('edit-location-accuracy', c.locationAccuracy)); add('Elevation (ft)', pick(c, 'elevation'));
    add('Entrance type', label('edit-entrance-type', c.entranceType)); add('Field indication', label('edit-field-indication', c.fieldIndication));
    add('Entry status', label('edit-entry-status', c.entryStatus)); add('Owner', pick(c, 'ownerInfo', 'ownerEntityInfo'));
    add('Geology', label('edit-geology', pick(c, 'geology', 'geologicFormation'))); add('Topographic province', label('edit-topo-province', pick(c, 'topoProvince', 'topographicProvince')));
    add('Map type', label('edit-map-type', c.mapType)); add('Map status', label('edit-map-status', c.mapStatus));
    add('Length (ft)', pick(c, 'caveLength', 'length')); add('Vertical extent (ft)', pick(c, 'verticalExtent', 'vertical'));
    add('Max water depth (ft)', pick(c, 'maxWaterDepth', 'waterDepth', 'water')); add('Deepest pitch (ft)', pick(c, 'deepestPitch', 'pitch'));
    add('Equipment', codeList(c.equipment).map((x) => checkboxLabel('edit-equipment-', x)).join('; '));
    add('Exploration', codeList(c.exploration).map((x) => checkboxLabel('edit-exploration-', x)).join('; '));
    const hz = c.hazards || {};
    add('Hazards', ['badAir', 'unstable', 'casualties', 'histoplasmosis'].filter((k) => hz[k]).map((k) => ({ badAir: 'Bad Air', unstable: 'Unstable Structure', casualties: 'Known Casualties', histoplasmosis: 'Histoplasmosis' }[k])).join(', '));
    add('Hazard notes', hz.notes); add('Notes', c.notes); add('Reporter', [pick(c, 'reporterName'), pick(c, 'reporterNSS')].filter(Boolean).join(', NSS '));
    if (Array.isArray(c.entrances) && c.entrances.length) {
      lines.push('', 'ENTRANCES');
      c.entrances.forEach((e, i) => lines.push(`- ${e.name || `Entrance ${i + 1}`}: ${e.latitude || ''}, ${e.longitude || ''}${e.entranceType ? `, type ${e.entranceType}` : ''}${e.elevation ? `, ${e.elevation} ft` : ''}`));
    }
    lines.push('', `NARRATIVES (${data.narratives.length})`);
    data.narratives.forEach((n) => { lines.push('', `--- by ${n.user || 'unknown'}, ${fmtDate(n.lastModified || n.timestamp)} ---`, htmlToText(n.html)); });
    if (data.maps.length) { lines.push('', 'MAP FILES'); data.maps.forEach((m) => lines.push(`- ${m.filename} (${m.kind}${m.link === 'possible' ? ', possible match' : ''})`)); }
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${c.id}-profile.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function changeLink(m, action, caveId) {
    try {
      const response = await fetch('/api/map-links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: m.key, caveId, action }) });
      const r = await response.json();
      if (!response.ok) throw new Error(r.error || 'Could not change the link');
      openCaveProfile(caveId);
    } catch (err) {
      alert(err.message);
    }
  }

  function wire(panel, data, lat, lng) {
    const cave = data.cave;
    panel.addEventListener('click', (e) => {
      const t = e.target.closest('[data-cp]');
      if (!t) return;
      const act = t.getAttribute('data-cp');
      const m = t.dataset.i !== undefined ? data.maps[Number(t.dataset.i)] : null;
      if (act === 'back') goBack();
      else if (act === 'map') viewOnMap(cave, lat, lng);
      else if (act === 'edit') window.editCaveFromMap && window.editCaveFromMap(cave.id);
      else if (act === 'narrate') addNarrative(cave.id);
      else if (act === 'download') downloadProfile(data);
      else if (act === 'cavemaps') document.querySelector('.tab[data-tab="cave-maps-section"]').click();
      else if (act === 'review') { const tab = document.querySelector('.tab[data-tab="pending-submissions"]'); if (tab) tab.click(); }
      else if (act === 'overlay' && m) showOverlay(m);
      else if (act === 'preview' && m) previewScan(m);
      else if (act === 'link' && m) changeLink(m, 'link', cave.id);
      else if (act === 'unlink' && m) changeLink(m, 'unlink', cave.id);
      else if (act === 'dismiss' && m) changeLink(m, 'dismiss', cave.id);
      else if (act === 'expand') {
        const box = panel.querySelector(`[data-cp-narr="${t.dataset.i}"]`);
        const open = box.classList.toggle('clamped');
        t.textContent = open ? 'Read more' : 'Show less';
      } else return;
      if (t.tagName === 'A') e.preventDefault();
    });
    // section bar
    panel.querySelectorAll('.cp-nav a').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = panel.querySelector(a.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      panel.querySelectorAll('.cp-nav a').forEach((x) => x.classList.toggle('on', x === a));
    }));
    // only show "Read more" where the text is actually cut off
    panel.querySelectorAll('[data-cp-narr]').forEach((box) => {
      const btn = panel.querySelector(`[data-cp="expand"][data-i="${box.dataset.cpNarr}"]`);
      if (btn && box.scrollHeight <= box.clientHeight + 4) { box.classList.remove('clamped'); btn.hidden = true; }
    });
    wireFind(panel);
  }

  function wireFind(panel) {
    const form = panel.querySelector('[data-cp="find"]');
    const input = panel.querySelector('[data-cp="find-input"]');
    const list = panel.querySelector('[data-cp="suggest"]');
    const all = () => (window.caveDataStore || []);
    function show() {
      const q = input.value.trim().toLowerCase();
      list.innerHTML = '';
      if (!q) { list.hidden = true; return; }
      const hits = all().filter((c) => String(c.id).toLowerCase().includes(q) || String(c.name || '').toLowerCase().includes(q)).slice(0, 12);
      hits.forEach((c, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        if (i === 0) li.className = 'on';
        li.textContent = `${c.id} – ${c.name || 'Unnamed'}`;
        li.addEventListener('click', () => openCaveProfile(c.id));
        list.appendChild(li);
      });
      if (!hits.length) { const li = document.createElement('li'); li.textContent = 'No matching cave'; list.appendChild(li); }
      list.hidden = false;
    }
    input.addEventListener('input', show);
    form.addEventListener('submit', (e) => { e.preventDefault(); const first = list.querySelector('li[role="option"]'); if (first) first.click(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.cp-find')) list.hidden = true; });
  }

  window.openCaveProfile = openCaveProfile;
})();
