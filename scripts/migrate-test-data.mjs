// One-time backfill: convert assets/test-data into a slim snapshot under
// public/data/snapshots/{date}/. The original gather did not capture
// dates.lastConnectionAt, so the `la` field is null on every player here.
//
// Usage: node scripts/migrate-test-data.mjs --date 2026-05-02

import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { argv } from 'process';

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

if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('Usage: node scripts/migrate-test-data.mjs --date YYYY-MM-DD');
  process.exit(1);
}

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'assets', 'test-data');
const DATA_DIR = join(ROOT, 'public', 'data');
const SNAPSHOT_DIR = join(DATA_DIR, 'snapshots', dateArg);
const PLAYERS_DIR = join(SNAPSHOT_DIR, 'players');

mkdirSync(PLAYERS_DIR, { recursive: true });

const countries = JSON.parse(readFileSync(join(SRC, 'countries.json'), 'utf-8'));
const slimCountries = countries.map(c => ({ name: c.name, code: c.code }));
writeFileSync(join(DATA_DIR, 'countries.json'), JSON.stringify(slimCountries));
console.log(`Wrote slim countries.json (${slimCountries.length} countries)`);

let totalPlayers = 0;
const countryFiles = readdirSync(join(SRC, 'players')).filter(f => f.endsWith('.json'));

for (const file of countryFiles) {
  const players = JSON.parse(readFileSync(join(SRC, 'players', file), 'utf-8'));
  const slim = players.map(p => ({
    l: p.level ?? 0,
    r: p.militaryRank ?? 0,
    la: null,
    s: SKILL_ORDER.map(k => p.skills?.[k]?.level ?? 0),
  }));
  writeFileSync(join(PLAYERS_DIR, file), JSON.stringify(slim));
  totalPlayers += slim.length;
}

writeFileSync(join(SNAPSHOT_DIR, 'meta.json'), JSON.stringify({
  date: dateArg,
  generatedAt: new Date().toISOString(),
  complete: true,
  countryCount: countryFiles.length,
  playerCount: totalPlayers,
  skillOrder: SKILL_ORDER,
  source: 'backfilled-from-test-data',
  note: 'la (lastConnectionAt) is null — original gather did not capture this field',
}));

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

console.log(`Done. ${totalPlayers} players across ${countryFiles.length} countries → ${SNAPSHOT_DIR}`);
