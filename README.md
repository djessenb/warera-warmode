<p align="center">
  <img src="public/favicon.svg" width="128" alt="Warera War Mode" />
</p>

<h1 align="center">Warera War Mode</h1>

A war-readiness dashboard for [warera.io](https://warera.io) — analyse player skill distributions across every country to find which nations are battle-ready.

Live: **[warera-warmode.web.app](https://warera-warmode.web.app)**

Built with Angular 20, Tailwind v4, and flatpickr. Hosted on Firebase, gathered via GitHub Actions.

## What it does

- Lists every country in warera.io with per-country player counts
- Filter players by minimum skill levels (attack, health, crit chance, crit damage, precision)
- Filter by minimum account level (default: lvl 20+)
- Filter by recent activity (default: active in the last 7 days, once activity data is available)
- Compute the percentage of each country's players that meet your war-readiness thresholds
- Pick a date range — see the delta of war-ready players between two snapshots
- Click a country row to expand a timeline chart showing how many were combat-ready each day in the selected window

## Architecture

```
warera.io API  ◀── via War Era Gateway (gateway.warerastats.io)
     │            caching + server-side batching, 200 req/min; falls back
     │            to api2.warera.io directly if the gateway is unreachable
     ▼
GitHub Actions (cron: 00:00 UTC daily)
     │  scripts/gather-data.mjs --date YYYY-MM-DD --force
     │  (fetches profiles concurrently — CONCURRENCY=25)
     ▼
public/data/snapshots/{YYYY-MM-DD}/
     ├── meta.json                 (date, generatedAt, complete, skillOrder)
     └── players/{cc}.json         (slim per-player records)
     │
     │  git commit → push to main
     ▼
firebase-hosting-merge.yml
     │  npm ci && npm run build && firebase deploy
     ▼
Firebase Hosting → warera-warmode.web.app
```

Two GitHub Actions workflows do the heavy lifting:
- `.github/workflows/snapshot.yml` — daily cron + `workflow_dispatch`. Runs the gather script, commits the new snapshot to main.
- `.github/workflows/firebase-hosting-merge.yml` — fires on every push to main, builds, deploys.

The snapshot push lands on main and the deploy workflow picks it up automatically — fresh data on the live site within ~2 hours of midnight UTC.

## Data layout

```
public/data/
  countries.json                   # slim country index (only changes when warera adds/removes a country)
  snapshots/
    index.json                     # { snapshots: [...dates], latest: "..." }
    2026-05-02/
      meta.json
      players/
        nl.json
        de.json
        ...

assets/test-data/                  # original full-fidelity gather, kept for reference
  countries.json
  players/{cc}.json
```

### Slim per-player schema

Each player is a compact positional record (~80 bytes vs ~700 in the original gather):

```json
{ "l": 25, "r": 54, "la": "2026-05-02T16:59:22.066Z", "s": [0,4,3,5,4,0,0,4,4,4,5,4,4,0] }
```

| Key | Meaning | Source field |
|---|---|---|
| `l` | account level | `leveling.level` |
| `r` | military rank | `militaryRank` |
| `la` | last connection (ISO) | `dates.lastConnectionAt` |
| `s` | skill levels in fixed order | `skills.<name>.level` |

Skill order — fixed, do not reorder, append-only:

```
0  energy           7  criticalChance
1  health           8  criticalDamages
2  hunger           9  armor
3  attack          10  precision
4  companies       11  dodge
5  entrepreneurship 12 lootChance
6  production      13  management
```

## Local development

```bash
npm install
npm start                # ng serve, http://localhost:4200
npm run build            # production build → dist/warmode/browser
```

The dev server reads from `public/data/snapshots/...` directly, same as production. Backfilled data for 2026-05-02 is included so the app works out of the box without running the gather.

### Re-running the gather locally

```bash
node scripts/gather-data.mjs --date 2026-05-04 --force
```

Flags:
- `--date YYYY-MM-DD` (default: today UTC) — which snapshot directory to write
- `--force` — overwrite per-country files that already exist for that date (default behaviour: skip, so partial runs are resumable)

The script fetches profiles concurrently (`CONCURRENCY=25`) through the War Era Gateway, which coalesces each wave of requests into a single upstream call. This brings a full run (~180 countries / 15K players) down from ~3 hours to a few minutes. If the gateway is unreachable it transparently falls back to `api2.warera.io` (slower, since that path is bound by the raw 100 req/min limit and 429-backoff).

Environment:
- `GATEWAY_API_KEY` — the `X-API-Key` sent to the gateway (default `warera-warmode`). Any non-empty value works; it only buckets per-key rate limits.

### Re-converting the test data

If you ever wipe the slim snapshots, you can rebuild the 2026-05-02 baseline from the original gather:

```bash
node scripts/migrate-test-data.mjs --date 2026-05-02
```

`la` is `null` on every record in the backfilled snapshot — the original gather didn't capture `dates.lastConnectionAt`. The activity filter is hidden in the UI when no snapshot has activity data.

## Deployment

Pushes to `main` auto-deploy via `.github/workflows/firebase-hosting-merge.yml`. Manual deploy:

```bash
npm run build
firebase deploy
```

Pull requests get a Firebase Hosting preview channel automatically.

## Tech stack

- Angular 20 (signals, control flow syntax)
- Tailwind CSS v4 (minimal — most styling is component-scoped SCSS)
- flatpickr for the date range picker
- Firebase Hosting + GitHub Actions for the pipeline
- Node.js 22 for the gather script

## Author

Built by **djkobus**. The data is from warera.io's public API — no scraping, no auth, just polite polling. Not affiliated with the game.
