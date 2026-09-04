#!/usr/bin/env node
// Regenerates config/states.json - the state/county reference data every
// state's dropdowns, filters, and cave-ID generation are driven from (see
// GET /api/states in server.js and window.loadStatesConfig() in
// httpdocs/index.html). Re-run any time county data needs to be regenerated;
// output is deterministic given the same inputs.
//
// Florida is handled specially: its 67 county codes are extracted directly
// from the live #edit-county <select> in httpdocs/index.html, so they are
// guaranteed byte-identical to what's already in production use (real cave
// IDs already depend on these exact codes - they are never regenerated).
//
// Every other state's counties come from scripts/data/us-counties.csv (a
// trimmed county,state name list derived from public Census-based data -
// see the file for provenance) with a 2-letter code assigned deterministically
// per county (see assignCountyCodes below). These are brand new states with
// no existing cave data, so there's no backward-compatibility constraint on
// their codes - but a human should still spot-check a freshly generated
// state's list before real submissions rely on it.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'httpdocs', 'index.html');
const COUNTIES_CSV = path.join(__dirname, 'data', 'us-counties.csv');
const OUT_FILE = path.join(ROOT, 'config', 'states.json');

// USPS state codes and names for the 50 states. DC and territories are
// deliberately left out for now (not requested; easy to add later the same
// way once the county CSV row for them is included).
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

function extractFloridaCounties() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const match = html.match(/<select id="edit-county">([\s\S]*?)<\/select>/);
  if (!match) {
    throw new Error('Could not find #edit-county <select> in httpdocs/index.html');
  }
  const options = [...match[1].matchAll(/<option value="([A-Z]{2})">([^<]+)<\/option>/g)];
  if (options.length !== 67) {
    throw new Error(`Expected 67 Florida counties, found ${options.length} - aborting rather than risk a bad extraction.`);
  }
  return options.map(([, code, name]) => ({ code, name }));
}

function loadCountiesByState() {
  const csv = fs.readFileSync(COUNTIES_CSV, 'utf8');
  const byState = {};
  for (const line of csv.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const commaIndex = trimmed.indexOf(',');
    const state = trimmed.slice(0, commaIndex);
    const rawName = trimmed.slice(commaIndex + 1);
    if (state === 'FL' || state === 'DC') continue; // FL handled separately; DC out of scope for now
    if (!STATE_NAMES[state]) continue; // ignore anything not in our 50-state list
    (byState[state] = byState[state] || []).push(rawName);
  }
  return byState;
}

// Strips the legal-entity suffix ("County", "Parish", "Borough", etc.) so
// code assignment works off just the place name.
function stripSuffix(name) {
  return name
    .replace(/\s+(County|Parish|Borough|Census Area|Municipality|Municipio|City and Borough)$/i, '')
    .replace(/\s+city$/, '') // Virginia/Maryland/Missouri independent cities
    .trim();
}

// Deterministically assigns a unique 2-letter uppercase code to every county
// name in the given (ordered) list. Same input list always produces the
// same output, so regenerating is a reviewable no-op unless the source data
// actually changed.
function assignCountyCodes(names) {
  const used = new Set();
  return names.map((rawName) => {
    const clean = stripSuffix(rawName).toUpperCase().replace(/[^A-Z\s]/g, '');
    const words = clean.split(/\s+/).filter(Boolean);
    const firstWord = words[0] || 'XX';

    const candidates = [];
    if (words.length >= 2) candidates.push(words[0][0] + words[1][0]);
    if (firstWord.length >= 2) candidates.push(firstWord.slice(0, 2));

    let code = candidates.find((c) => c.length === 2 && !used.has(c));

    if (!code) {
      // Systematic fallback: fix the first letter of the name, scan the
      // second letter A-Z for an unused combination.
      const first = firstWord[0] || 'X';
      for (let i = 0; i < 26 && !code; i++) {
        const candidate = first + String.fromCharCode(65 + i);
        if (!used.has(candidate)) code = candidate;
      }
    }

    if (!code) {
      // Last resort: scan every one of the 676 two-letter combinations.
      // Never actually reached in practice (max county count is Texas's
      // 254, far below 676), but keeps this function total.
      outer: for (let a = 0; a < 26; a++) {
        for (let b = 0; b < 26; b++) {
          const candidate = String.fromCharCode(65 + a) + String.fromCharCode(65 + b);
          if (!used.has(candidate)) {
            code = candidate;
            break outer;
          }
        }
      }
    }

    used.add(code);
    return { code, name: stripSuffix(rawName) };
  });
}

function build() {
  const floridaCounties = extractFloridaCounties();
  const countiesByState = loadCountiesByState();

  const states = [
    {
      code: 'FL',
      name: 'Florida',
      caveIdPrefix: 'F',
      counties: floridaCounties,
    },
  ];

  const otherCodes = Object.keys(STATE_NAMES).filter((c) => c !== 'FL').sort();
  for (const code of otherCodes) {
    const rawNames = (countiesByState[code] || []).sort();
    states.push({
      code,
      name: STATE_NAMES[code],
      caveIdPrefix: code,
      counties: assignCountyCodes(rawNames),
    });
  }

  return { states };
}

const config = build();
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(config, null, 2) + '\n');

const totalCounties = config.states.reduce((sum, s) => sum + s.counties.length, 0);
console.log(`Generated ${config.states.length} states, ${totalCounties} counties total.`);
console.log(`Written to ${OUT_FILE}`);
