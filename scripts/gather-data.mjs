import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const API = 'https://api2.warera.io/trpc';
const DATA_DIR = join(import.meta.dirname, '..', 'public', 'data');
const PLAYERS_DIR = join(DATA_DIR, 'players');

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

// Step 1: Fetch all countries
console.log('Fetching all countries...');
const countries = await trpc('country.getAllCountries');
console.log(`Got ${countries.length} countries`);

const countryIndex = countries.map(c => ({
  _id: c._id,
  name: c.name,
  code: c.code,
  rankings: c.rankings,
  development: c.development,
  money: c.money,
}));

writeFileSync(join(DATA_DIR, 'countries.json'), JSON.stringify(countryIndex, null, 2));
console.log('Saved countries.json');

// Step 2: For each country, paginate all players (skip already done)
for (const country of countryIndex) {
  const outFile = join(PLAYERS_DIR, `${country.code}.json`);
  if (existsSync(outFile)) {
    const existing = JSON.parse(readFileSync(outFile, 'utf-8'));
    console.log(`Skipping ${country.name} (${country.code}) - already has ${existing.length} players`);
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

  // Fetch full profiles one at a time with throttling
  console.log(`  Fetching ${allPlayerIds.length} full profiles...`);
  const players = [];

  for (let i = 0; i < allPlayerIds.length; i++) {
    const id = allPlayerIds[i];
    try {
      const user = await trpc('user.getUserById', { userId: id });
      players.push({
        _id: user._id,
        username: user.username,
        level: user.leveling?.level,
        skillPoints: user.leveling?.spentSkillPoints,
        skills: Object.fromEntries(
          Object.entries(user.skills || {}).map(([k, v]) => [k, { level: v.level, total: v.total }])
        ),
        militaryRank: user.militaryRank,
        createdAt: user.createdAt,
      });
    } catch (err) {
      console.warn(`    Failed to fetch user ${id}: ${err.message}`);
    }

    // Throttle: pause every 3 requests
    if ((i + 1) % 3 === 0) await sleep(2000);

    if ((i + 1) % 50 === 0 || i + 1 === allPlayerIds.length) {
      console.log(`    ${i + 1}/${allPlayerIds.length} profiles fetched`);
    }
  }

  writeFileSync(outFile, JSON.stringify(players, null, 2));
  console.log(`  Saved ${country.code}.json (${players.length} players)`);
}

console.log('\nDone!');
