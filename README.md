# Warera.io War Mode

A war readiness dashboard for [warera.io](https://warera.io) — analyze player skill distributions per country to determine which nations are battle-ready.

Built with Angular 20 and Tailwind CSS. Hosted on Firebase.

## What it does

- Shows all countries in warera.io with their player counts
- Filters players by minimum combat skill levels (attack, health, crit chance, crit damage, precision)
- Calculates what percentage of each country's players meet your war readiness thresholds
- Displays average skill levels per country for the matched players
- Filter by level 20+ to focus on endgame players only

## Data gathering

Player data is fetched from the [warera.io public API](https://api2.warera.io/docs/) and stored as static JSON files. This is a snapshot — not live data.

The gather script (`scripts/gather-data.mjs`) does the following:

1. Fetches all countries via `GET /trpc/country.getAllCountries`
2. For each country, paginates through all players via `GET /trpc/user.getUsersByCountry`
3. Fetches full player profiles (skills, level, military rank) via `GET /trpc/user.getUserById`
4. Saves country list to `public/data/countries.json`
5. Saves per-country player data to `public/data/players/{countryCode}.json`

The script has built-in rate limit handling (retries on 429s) and resume support — if it crashes, re-run it and it skips countries that already have a JSON file.

### Running the gather script

```bash
node scripts/gather-data.mjs
```

This takes a while (~180 countries, thousands of players, with API rate limiting). To re-gather a specific country, delete its JSON file first:

```bash
rm public/data/players/eg.json
node scripts/gather-data.mjs
```

## Development

```bash
npm install
ng serve
```

Open [http://localhost:4200](http://localhost:4200).

## Build & deploy

```bash
ng build
firebase deploy
```

The build output goes to `dist/warmode/browser/` which Firebase Hosting serves.

## Tech stack

- Angular 20
- Tailwind CSS v4
- Firebase Hosting
- Node.js 22 (for the gather script)

## Author

Built by **djkobus**.
