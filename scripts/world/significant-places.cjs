#!/usr/bin/env node
'use strict';
// The places every build must give a station, whatever the local rules would thin away (Likea, 2026-09-30: "there's
// no reason Chicago or Amsterdam shouldn't appear", and a city of a million can never be purged): national capitals,
// cities of a million people or more, and the places Natural Earth ranks among the world's most important, which is
// its measure of historical and cultural weight as much as size (Samarkand, Lhasa and Churchill as well as Chicago).
//
// Reads Natural Earth's 1:10m populated places (public domain), fetched once into the build cache, and writes the ones
// that qualify to world/external/significant-places.json. Usage: npm run world:significant-places
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defaultCache } = require('./dem.cjs');

const URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_populated_places_simple.geojson';
const MILLION = 1000000;
// Natural Earth's scalerank runs from 0 (the most important places) to 10; 3 and better holds the world cities, the
// capitals of states and provinces that matter on a world map, and famous places of any size.
const MAX_SCALERANK = 3;
const CAPITALS = new Set(['Admin-0 capital', 'Admin-0 capital alt']);
const KINDS = new Set(['Populated place', 'Populated Place', 'Admin-0 capital', 'Admin-0 capital alt', 'Admin-1 capital',
  'Admin-1 region capital', 'Admin-0 region capital', 'Historic place']);

function reasonsFor(place) {
  const reasons = [];
  if (CAPITALS.has(place.featurecla)) reasons.push('capital');
  if (place.pop_max >= MILLION) reasons.push('million');
  if (place.worldcity) reasons.push('world city');
  if (place.scalerank <= MAX_SCALERANK) reasons.push('rank ' + place.scalerank);
  return reasons;
}

function main() {
  const root = path.resolve(__dirname, '../..');
  const cached = path.join(defaultCache(), 'ne_10m_populated_places_simple-5.1.2.geojson');
  if (!fs.existsSync(cached)) execFileSync('curl', ['-sSfL', '-o', cached, URL], { stdio: 'inherit' });
  const features = JSON.parse(fs.readFileSync(cached, 'utf8')).features;
  const places = features.map(feature => feature.properties)
    .filter(place => KINDS.has(place.featurecla))
    .map(place => ({ place, reasons: reasonsFor(place) }))
    .filter(({ reasons }) => reasons.length)
    .map(({ place, reasons }) => ({
      id: 'ne:' + place.ne_id, name: place.nameascii || place.name, country: place.adm0name,
      coordinates: [Math.round(place.longitude * 1e5) / 1e5, Math.round(place.latitude * 1e5) / 1e5],
      population: place.pop_max, reasons
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const output = path.join(root, 'world/external/significant-places.json');
  fs.writeFileSync(output, JSON.stringify({ source: URL, rules: { capitals: [...CAPITALS], minPopulation: MILLION,
    maxScalerank: MAX_SCALERANK, worldCities: true }, places }, null, 0).replace(/\},\{"id"/g, '},\n{"id"') + '\n');
  console.log('Wrote ' + places.length + ' significant places to ' + path.relative(root, output));
}

main();
