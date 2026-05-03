import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { argv } from 'process';

const API = 'https://api2.warera.io/trpc';

// Skill schema: positional array of skill levels in this fixed order.
// DO NOT REORDER — the frontend depends on the index. Append new skills only.
const SKILL_ORDER = [
  'energy',           // 0
  'health',           // 1
  'hunger',           // 2
  'attack',           // 3
  'companies',        // 4
  'entrepreneurship', // 5
  'production',       // 6
  'criticalChance',   // 7
  'criticalDamages',  // 8
  'armor',            // 9
  'precision',        // 10
  'dodge',            // 11
  'lootChance',       // 12
  'management',       // 13
];

const args = argv.slice(2);
const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (args.includes('--date') ? args[args.indexOf('--date') + 1] : null);
const force = args.includes('--force');

const date = dateArg ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`Invalid date "${date}". Expected YYYY-MM-DD.`);
  process.exit(1);
}

const DATA_DIR = join(import.meta.dirname, '..', 'public', 'data');
const SNAPSHOT_DIR = join(DATA_DIR, 'snapshots', date);
const PLAYERS_DIR = join(SNAPSHOT_DIR, 'players');
const META_FILE = join(SNAPSHOT_DIR, 'meta.json');

mkdirSync(PLAYERS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function trpc(procedure, input = {}, retries = 5) {
  const url = `${API}/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      return json.result.data;
    }
    if (res.status === 429) {
      const wait = attempt * 3000;
      console.log(`    Rate limited on ${procedure}, waiting ${wait / 1000}s (attempt ${attempt}/${retries})`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${procedure} failed: ${res.status}`);
  }
  throw new Error(`${procedure} failed after ${retries} retries (429)`);
}

console.log(`Snapshot date: ${date} (force=${force})`);

writeFileSync(META_FILE, JSON.stringify({
  date,
  generatedAt: new Date().toISOString(),
  complete: false,
  skillOrder: SKILL_ORDER,
}));

console.log('Fetching all countries...');
const countries = await trpc('country.getAllCountries');
console.log(`Got ${countries.length} countries`);

const slimCountries = countries.map(c => ({ name: c.name, code: c.code }));
const countriesPath = join(DATA_DIR, 'countries.json');
const newCountries = JSON.stringify(slimCountries);
const existingCountries = existsSync(countriesPath) ? readFileSync(countriesPath, 'utf-8') : null;
if (existingCountries !== newCountries) {
  writeFileSync(countriesPath, newCountries);
  console.log(`countries.json changed (${slimCountries.length} countries) — saved`);
} else {
  console.log(`countries.json unchanged (${slimCountries.length} countries) — skipping`);
}

let totalPlayers = 0;
for (const country of countries) {
  const outFile = join(PLAYERS_DIR, `${country.code}.json`);
  if (existsSync(outFile) && !force) {
    const existing = JSON.parse(readFileSync(outFile, 'utf-8'));
    console.log(`Skipping ${country.name} (${country.code}) - already has ${existing.length} players`);
    totalPlayers += existing.length;
    continue;
  }

  console.log(`\nFetching players for ${country.name} (${country.code})...`);
  const allPlayerIds = [];
  let cursor = undefined;
  let page = 0;

  while (true) {
    const input = { countryId: country._id, limit: 100 };
    if (cursor) input.cursor = cursor;

    const data = await trpc('user.getUsersByCountry', input);
    allPlayerIds.push(...data.items.map(i => i._id));
    page++;
    console.log(`  Page ${page}: ${data.items.length} users (total: ${allPlayerIds.length})`);

    if (!data.nextCursor || data.items.length < 100) break;
    cursor = data.nextCursor;
    await sleep(1500);
  }

  console.log(`  Fetching ${allPlayerIds.length} full profiles...`);
  const players = [];

  for (let i = 0; i < allPlayerIds.length; i++) {
    const id = allPlayerIds[i];
    try {
      const user = await trpc('user.getUserById', { userId: id });
      players.push({
        l: user.leveling?.level ?? 0,
        r: user.militaryRank ?? 0,
        la: user.dates?.lastConnectionAt ?? null,
        s: SKILL_ORDER.map(k => user.skills?.[k]?.level ?? 0),
      });
    } catch (err) {
      console.warn(`    Failed to fetch user ${id}: ${err.message}`);
    }

    if ((i + 1) % 3 === 0) await sleep(2000);

    if ((i + 1) % 50 === 0 || i + 1 === allPlayerIds.length) {
      console.log(`    ${i + 1}/${allPlayerIds.length} profiles fetched`);
    }
  }

  writeFileSync(outFile, JSON.stringify(players));
  console.log(`  Saved ${country.code}.json (${players.length} players)`);
  totalPlayers += players.length;
}

writeFileSync(META_FILE, JSON.stringify({
  date,
  generatedAt: new Date().toISOString(),
  complete: true,
  countryCount: countries.length,
  playerCount: totalPlayers,
  skillOrder: SKILL_ORDER,
}));

// Refresh snapshots/index.json by listing complete snapshot dirs.
const SNAPSHOTS_ROOT = join(DATA_DIR, 'snapshots');
const snapshotDates = readdirSync(SNAPSHOTS_ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .map(d => d.name)
  .filter(name => {
    try {
      const m = JSON.parse(readFileSync(join(SNAPSHOTS_ROOT, name, 'meta.json'), 'utf-8'));
      return m.complete === true;
    } catch {
      return false;
    }
  })
  .sort();
writeFileSync(
  join(SNAPSHOTS_ROOT, 'index.json'),
  JSON.stringify({ snapshots: snapshotDates, latest: snapshotDates.at(-1) ?? null }),
);

console.log(`\nDone! ${totalPlayers} players across ${countries.length} countries.`);
