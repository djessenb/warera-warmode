import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { argv } from 'process';

// Primary: the War Era Gateway (caching + server-side batching/dedup, 200 req/min
// per key). Falls back to the raw warera API if the gateway is unreachable.
// The gateway accepts any non-empty X-API-Key — it only buckets per-key rate limits.
// Attribution: Supported by warerastats.io (https://gateway.warerastats.io).
const GATEWAY = 'https://gateway.warerastats.io/trpc';
const API2 = 'https://api2.warera.io/trpc';
const API_KEY = process.env.GATEWAY_API_KEY || 'warera-warmode';

// How many profile fetches to keep in flight. The gateway coalesces each ~400ms
// wave of concurrent requests into a single upstream call, so concurrency — not
// big tRPC batch requests — is what makes this fast.
const CONCURRENCY = 25;

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

// Once the gateway proves unreachable we flip to api2 for the rest of the run,
// rather than re-probing it on every request.
let useGateway = true;
function switchToApi2(reason) {
  if (!useGateway) return;
  useGateway = false;
  console.warn(`⚠ Gateway unavailable (${reason}) — falling back to api2.warera.io for the rest of this run`);
}

async function trpc(procedure, input = {}, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const base = useGateway ? GATEWAY : API2;
    const url = `${base}/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;

    let res;
    try {
      res = await fetch(url, useGateway ? { headers: { 'X-API-Key': API_KEY } } : undefined);
    } catch (err) {
      // Network-level failure. Fall back to api2 (without burning a retry) on the
      // gateway; otherwise back off and retry.
      if (useGateway) { switchToApi2(err.message); attempt--; continue; }
      if (attempt === retries) throw err;
      await sleep(attempt * 2000);
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      return json.result.data;
    }
    if (res.status === 429) {
      const wait = attempt * 2000;
      console.log(`    Rate limited on ${procedure}, waiting ${wait / 1000}s (attempt ${attempt}/${retries})`);
      await sleep(wait);
      continue;
    }
    // 5xx from the gateway → fall back to api2; any other status is a real error.
    if (useGateway && res.status >= 500) { switchToApi2(`HTTP ${res.status}`); attempt--; continue; }
    throw new Error(`${procedure} failed: ${res.status}`);
  }
  throw new Error(`${procedure} failed after ${retries} retries`);
}

// Run `worker` over `items` with at most `concurrency` in flight, preserving
// result order.
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
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
  }

  console.log(`  Fetching ${allPlayerIds.length} full profiles (concurrency ${CONCURRENCY})...`);
  let done = 0;
  const profiles = await mapPool(allPlayerIds, CONCURRENCY, async id => {
    try {
      const user = await trpc('user.getUserById', { userId: id });
      return {
        l: user.leveling?.level ?? 0,
        r: user.militaryRank ?? 0,
        la: user.dates?.lastConnectionAt ?? null,
        s: SKILL_ORDER.map(k => user.skills?.[k]?.level ?? 0),
      };
    } catch (err) {
      console.warn(`    Failed to fetch user ${id}: ${err.message}`);
      return null;
    } finally {
      done++;
      if (done % 200 === 0 || done === allPlayerIds.length) {
        console.log(`    ${done}/${allPlayerIds.length} profiles fetched`);
      }
    }
  });
  const players = profiles.filter(Boolean);

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
