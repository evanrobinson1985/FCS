#!/usr/bin/env node
// Regenerates data/cave-database.example.json - the dummy seed data a fresh
// checkout copies to data/cave-database.json to get the site running with
// something to look at (see data/README.md). Every cave here is entirely
// fictional (procedurally generated, deterministic seed below), not a real
// survey record - re-run this any time to regenerate the same 120 caves, or
// tweak CAVE_COUNT/the word lists and re-run to produce a different set.
const fs = require('fs');
const path = require('path');

// Approximate county centroids (rounded, illustrative only) for a spread of
// real Florida counties, biased toward the karst-heavy regions (north/
// central FL) where most of the state's caves actually are - but every
// cave generated from this is entirely fictional; these are just
// plausible-looking anchor points to jitter around.
const COUNTIES = [
  ['AL', 'Alachua', 29.68, -82.34],
  ['CI', 'Citrus', 28.87, -82.49],
  ['LV', 'Levy', 29.30, -82.78],
  ['MR', 'Marion', 29.21, -82.14],
  ['SF', 'Suwannee', 30.13, -83.00],
  ['CU', 'Columbia', 30.20, -82.62],
  ['HA', 'Hamilton', 30.48, -82.94],
  ['GC', 'Gilchrist', 29.75, -82.75],
  ['LF', 'Lafayette', 30.03, -83.13],
  ['DI', 'Dixie', 29.58, -83.15],
  ['HO', 'Hernando', 28.56, -82.44],
  ['PA', 'Pasco', 28.33, -82.35],
  ['JK', 'Jackson', 30.78, -85.22],
  ['JF', 'Jefferson', 30.43, -83.90],
  ['LL', 'Leon', 30.44, -84.28],
  ['WU', 'Wakulla', 30.17, -84.38],
  ['GG', 'Gadsden', 30.57, -84.62],
  ['WA', 'Walton', 30.60, -86.17],
  ['HB', 'Hillsborough', 27.97, -82.30],
  ['SU', 'Sumter', 28.72, -82.08],
  ['LK', 'Lake', 28.76, -81.68],
  ['PU', 'Putnam', 29.62, -81.75],
  ['BR', 'Bradford', 29.94, -82.17],
  ['UN', 'Union', 30.03, -82.36],
  ['BK', 'Baker', 30.33, -82.28],
  ['CL', 'Clay', 29.97, -81.85],
  ['DU', 'Duval', 30.33, -81.66],
  ['VO', 'Volusia', 29.03, -81.30],
  ['SJ', 'St. Johns', 29.90, -81.44],
  ['OR', 'Orange', 28.54, -81.38],
  ['OS', 'Osceola', 28.06, -81.21],
  ['PO', 'Polk', 27.99, -81.70],
  ['MN', 'Manatee', 27.49, -82.35],
  ['SA', 'Sarasota', 27.24, -82.35],
  ['CH', 'Charlotte', 26.99, -81.91],
  ['CO', 'Collier', 26.14, -81.42],
  ['GL', 'Glades', 26.96, -81.19],
  ['HR', 'Hardee', 27.51, -81.81],
  ['DE', 'Desoto', 27.19, -81.80],
  ['MO', 'Monroe', 24.92, -80.86],
];

const ADJECTIVES = [
  'Hidden', 'Whispering', 'Silent', 'Shadow', 'Crystal', 'Amber', 'Sunken',
  'Twilight', 'Echo', 'Blue', 'Emerald', 'Forgotten', 'Wandering', 'Old',
  'Lost', 'Misty', 'Golden', 'Quiet', 'Deep', 'Winding', 'Moss', 'Cedar',
  'Palmetto', 'Gator', 'Blackwater', 'Limestone', 'Sable', 'Ironwood',
];

const FEATURES = [
  'Cave', 'Cavern', 'Sink', 'Sinkhole', 'Grotto', 'Pit', 'Chamber',
  'Passage', 'Spring Cave', 'Hollow', 'Crossing', 'Vault', 'Den',
];

const PLACE_WORDS = [
  'Buzzard', 'Turtle', 'Heron', 'Osprey', 'Cypress', 'Oak', 'Pine',
  'Magnolia', 'Sabal', 'Panther', 'Otter', 'Bobcat', 'Kingfisher',
  'Sandhill', 'Scrub', 'Fern', 'Tupelo', 'Bayou', 'Ridge', 'Hollow',
];

const REPORTER_FIRST = ['A.', 'B.', 'C.', 'D.', 'E.', 'J.', 'K.', 'L.', 'M.', 'R.', 'S.', 'T.'];
const REPORTER_LAST = [
  'Sample', 'Example', 'Placeholder', 'Demo', 'Fixture', 'Testcase',
];

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

// Small deterministic PRNG (mulberry32) so this is reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260904);

const ENTRY_STATUS = ['C', 'D', 'F', 'G', 'K', 'L', 'N', 'P', 'R', 'W'];
const ENTRANCE_TYPE = ['E', 'K', 'L', 'H', 'T', 'A', 'B', 'C', 'O', 'P', 'S'];
const FIELD_INDICATION = ['B', 'F', 'H', 'I', 'O', 'Q', 'S', 'T', 'W', 'P', 'X'];
const MAP_TYPE = ['K', 'M', 'P', 'S', 'T', 'U'];
const MAP_STATUS = ['I', 'N', 'P', 'R'];
const GEOLOGY = ['HA', 'CH', 'SU', 'MA', 'CR', 'OC'];
const TOPO_PROVINCE = ['B', 'D', 'F', 'N', 'O', 'P', 'S', 'T', 'W'];
const LOCATION_ACCURACY = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'U'];
const EQUIPMENT_CODES = ['B', 'D', 'H', 'K', 'L', 'N', 'R', 'S', 'W', 'X'];
const EXPLORATION_CODES = ['B', 'C', 'D', 'E', 'N', 'S', 'T', 'W'];

function makeName(rng, usedNames) {
  let name;
  let attempts = 0;
  do {
    const style = Math.floor(rng() * 3);
    if (style === 0) {
      name = `${pick(ADJECTIVES, rng)} ${pick(FEATURES, rng)}`;
    } else if (style === 1) {
      name = `${pick(PLACE_WORDS, rng)} ${pick(FEATURES, rng)}`;
    } else {
      name = `${pick(ADJECTIVES, rng)} ${pick(PLACE_WORDS, rng)} ${pick(FEATURES, rng)}`;
    }
    attempts++;
  } while (usedNames.has(name) && attempts < 50);
  if (usedNames.has(name)) name = `${name} #${usedNames.size + 1}`;
  usedNames.add(name);
  return name;
}

const CAVE_COUNT = 120;
const caves = [];
const usedNames = new Set();
const countyCounters = {};

for (let i = 0; i < CAVE_COUNT; i++) {
  const [countyCode, countyName, baseLat, baseLng] = pick(COUNTIES, rng);
  countyCounters[countyCode] = (countyCounters[countyCode] || 0) + 1;
  const num = countyCounters[countyCode];
  const id = `F${countyCode}${String(num).padStart(3, '0')}`;

  // Jitter up to roughly +/- 0.12 degrees (~8 miles) around the county
  // centroid - close enough to land in/near the right county, but not a
  // real surveyed location.
  const lat = +(baseLat + (rng() - 0.5) * 0.24).toFixed(5);
  const lng = +(baseLng + (rng() - 0.5) * 0.24).toFixed(5);

  const isUnderwater = rng() < 0.15;
  const type = isUnderwater ? 'Underwater Cave' : 'Land Cave';
  const name = makeName(rng, usedNames);

  const length = Math.round(50 + rng() * rng() * 5000);
  const vertical = Math.round(rng() * rng() * 300);
  const waterDepth = isUnderwater ? Math.round(10 + rng() * 150) : Math.round(rng() * rng() * 40);
  const pitch = Math.round(rng() * rng() * 120);
  const elevation = Math.round(5 + rng() * 220);

  const equipment = EQUIPMENT_CODES.filter(() => rng() < 0.18);
  const exploration = EXPLORATION_CODES.filter(() => rng() < 0.15);

  const reporterName = `${pick(REPORTER_FIRST, rng)} ${pick(REPORTER_LAST, rng)}`;
  const year = 1975 + Math.floor(rng() * 50);
  const month = 1 + Math.floor(rng() * 12);

  const hazards = {
    badAir: rng() < 0.08,
    unstable: rng() < 0.15,
    casualties: rng() < 0.03,
    notes: rng() < 0.15 ? 'Sample hazard note - loose breakdown near the main passage.' : '',
  };

  const cave = {
    id,
    name,
    county: countyCode,
    type,
    latitude: lat,
    longitude: lng,
    lat,
    lng,
    elevation,
    entranceType: pick(ENTRANCE_TYPE, rng),
    fieldIndication: pick(FIELD_INDICATION, rng),
    entryStatus: pick(ENTRY_STATUS, rng),
    locationAccuracy: pick(LOCATION_ACCURACY, rng),
    ownerInfo: rng() < 0.5 ? 'Example Land Trust (sample data)' : 'Private landowner (sample data)',
    mapType: pick(MAP_TYPE, rng),
    mapStatus: pick(MAP_STATUS, rng),
    geology: pick(GEOLOGY, rng),
    topoProvince: pick(TOPO_PROVINCE, rng),
    length: String(length),
    caveLength: String(length),
    vertical: String(vertical),
    verticalExtent: String(vertical),
    waterDepth: String(waterDepth),
    water: String(waterDepth),
    maxWaterDepth: String(waterDepth),
    pitch: String(pitch),
    deepestPitch: String(pitch),
    equipment,
    exploration,
    reporterName,
    reporterNSS: String(10000 + Math.floor(rng() * 89999)),
    notes:
      'SAMPLE DATA - this record was generated as placeholder content and does not describe a ' +
      'real cave. Replace with real survey data before using this site to manage actual FCS records.',
    hazards,
    entrances: [
      {
        name: 'Main Entrance',
        entranceType: pick(ENTRANCE_TYPE, rng),
        fieldIndication: pick(FIELD_INDICATION, rng),
        entryStatus: pick(ENTRY_STATUS, rng),
        locationAccuracy: pick(LOCATION_ACCURACY, rng),
        latitude: lat,
        longitude: lng,
        elevation: String(elevation),
      },
    ],
    createdDate: `${year}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`,
    createdBy: 'seed-script (sample data)',
    lastUpdated: `${year}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`,
    updatedBy: 'seed-script (sample data)',
  };

  caves.push(cave);
}

caves.sort((a, b) => a.id.localeCompare(b.id));

const outFile = path.join(__dirname, '..', 'data', 'cave-database.example.json');
fs.writeFileSync(outFile, JSON.stringify(caves, null, 2) + '\n');

console.log(`Generated ${caves.length} caves across ${Object.keys(countyCounters).length} counties.`);
console.log(`Written to ${outFile}`);
