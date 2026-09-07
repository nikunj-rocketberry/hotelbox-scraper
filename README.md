# hotelbox-scraper — Setup & Testing Guide

Expedia hotel content scraper: NestJS + Playwright + BullMQ, ingesting into Postgres and MinIO.

## Architecture in one paragraph

Two processes share the same codebase: the **API process** (`main.ts`) only enqueues jobs and serves the dashboard/viewer — it never touches Playwright. The **worker process** (`worker.main.ts`) is what actually scrapes; run as many copies of it as you want parallel capacity. Both talk to the same Redis-backed BullMQ queues, in a three-stage pipeline:

```
region-discovery  →  city-hotels  →  hotel-detail
(find cities in     (find hotels    (scrape full detail
 a state)            in a city)      + rooms + photos for
                                      one hotel)
```

Each stage is its own queue, so you never manually pick a city id — seed a **country + state** and everything downstream (cities, hotel lists, hotel details, DB writes) cascades automatically.

---

## 1. Prerequisites

- Node.js 20+ and npm
- Docker (for Postgres, Redis, MinIO)

## 2. Install

```bash
npm install
npm run playwright:install   # downloads Chromium (+ OS deps) for Playwright
```

## 3. Start infrastructure

```bash
docker compose up -d
```

This starts three containers (see `docker-compose.yml`):

| Service  | Purpose                  | Host port |
|----------|---------------------------|-----------|
| Postgres | hotel/geo data            | 5439      |
| Redis    | BullMQ queues + shared state | 6379   |
| MinIO    | hotel/room photo storage  | 9000 (API), 9001 (web console) |

Check they're up: `docker ps` should list `hotelbox-scraper-postgres`, `-redis`, `-minio`.

## 4. Configure environment

```bash
cp .env.example .env
```

The defaults in `.env.example` already match `docker-compose.yml`, so for local dev you usually don't need to change anything. Skim it once anyway — it documents every tunable (worker concurrency, rate limiting, traffic shaping, anti-bot cooldown, etc.), summarized in [Tuning throughput](#8-tuning-throughput) below.

## 5. Build and run migrations

```bash
npm run build
npm run migration:run
```

`migration:run` creates the whole schema (`master_hotel`, `master_city`, `hotel_details`, `hotel_media`, rooms, amenities, ...) per `expedia_hotel_content_schema.md`.

## 6. Start the two processes

In separate terminals:

```bash
npm run start:api      # enqueues jobs, serves dashboard + viewer, port 3000
npm run start:worker   # does the actual Playwright scraping
```

(Use `npm run start:worker:dev` instead if you're iterating on scraper code — it restarts on file changes.)

You now have:
- API: `http://localhost:3000`
- Queue dashboard: `http://localhost:3000/admin/queues`
- Data viewer: `http://localhost:3000/viewer`
- MinIO console: `http://localhost:9001` (login `minioadmin` / `minioadmin`)

---

## 7. Before your first real scrape: check the selectors

`src/scraper/expedia-selectors.ts` ships with best-effort selectors that were **never verified against a live page** (Expedia's markup changes, and it rate-limits aggressively). A first run's most likely failure mode is silently finding 0 cities/hotels, not a crash. Spot-check before trusting a real run:

```bash
npm run playwright:inspect -- "https://www.expedia.co.in/Hotel-Search?destination=Karnataka%2C%20India"
```

This opens a real headed browser + Playwright Inspector. Click the "Destinations in Karnataka" cards and compare their actual `data-stid` attributes to `expedia-selectors.ts`. Fix any drift, then `npm run build` again.

Run this sparingly and manually — never in a loop or CI.

## 8. Tuning throughput

All of these live in `.env` (see `.env.example` for full descriptions) — defaults are conservative and safe to leave alone for a first test:

| Variable | Default | What it does |
|---|---|---|
| `WORKER_CONCURRENCY` | 2 | Concurrent jobs per worker process, per queue |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_DURATION_MS` | 20 / 60000 | Coarse BullMQ backstop: max job starts per window, fleet-wide |
| `TRAFFIC_SHAPER_ENABLED` / `_RATE_PER_HOUR` / `_BURST_CAPACITY` | true / 1000 / 5 | The real pacing mechanism: a Redis-backed token bucket shared by every worker process |
| `NAV_JITTER_MIN_MS` / `_MAX_MS` | 200 / 800 | Small random delay before every navigation, to avoid synchronized bursts |
| `PLAYWRIGHT_MAX_CONTEXTS` | 5 | Size of the reused BrowserContext pool per worker |
| `PLAYWRIGHT_BLOCK_RESOURCES` | true | Aborts image/font/media requests (only `src` attributes are ever read, never pixel data) |
| `HOTEL_LIST_MAX_PAGES` | 50 | Pagination ceiling per city — **lower this (e.g. `1`) for a small first test** |
| `RESCRAPE_FRESHNESS_DAYS` | 14 | Skip re-scraping a hotel synced more recently than this |
| `ANTI_BOT_COOLDOWN_MS` | 1800000 (30 min) | Fleet-wide pause after Expedia returns a block signal (429/403/CAPTCHA) |

For your very first test, consider setting `HOTEL_LIST_MAX_PAGES=1` in `.env` so one city doesn't pull in hundreds of hotels, then rebuild (`npm run build`) since a couple of these are read at process start.

---

## 9. Run a test scrape (India → Karnataka)

You don't need to know a city id — just seed the country + state and let discovery cascade:

```bash
npm run scrape:region -- --country "India" --iso2 IN --iso3 IND --state "Karnataka"
```

Equivalent via HTTP, if you'd rather use curl/Postman:

```bash
curl -X POST http://localhost:3000/scrape/region \
  -H "Content-Type: application/json" \
  -d '{"countryName":"India","countryIso2":"IN","countryIso3":"IND","stateName":"Karnataka"}'
```

To seed several states/countries at once (keeps the shared `hotel-detail` queue saturated instead of draining between single-region runs):

```bash
npm run scrape:regions -- --file regions.json
```
```json
[
  { "country": "India", "iso2": "IN", "iso3": "IND", "state": "Karnataka" },
  { "country": "India", "iso2": "IN", "iso3": "IND", "state": "Kerala" }
]
```

## 10. Watch it run

- **Queue dashboard**: `http://localhost:3000/admin/queues` — watch `region-discovery` → `city-hotels` → `hotel-detail` job counts move waiting → active → completed/failed, live.
- **Quick JSON snapshot**: `curl http://localhost:3000/scrape/status`
- **Worker logs** — every stage prints a summary line: `Discovered N cities in Karnataka`, `Enqueued N hotel-detail jobs for <city> (M skipped as already fresh, T found)`, `Saved hotel <name> (db id=..., N rooms, M photos)`.
- Watch for `Blocked by Expedia anti-bot (<reason>)` — this means the fleet-wide cooldown tripped (default 30 min); every job fails fast until it expires. That's the circuit breaker working as intended, not a bug — let it cool down rather than restarting workers to "fix" it.

To stop mid-run: just kill the worker process. Anything still queued stays queued in Redis and resumes safely when you restart the worker.

## 11. Look at the data

- **Viewer UI**: `http://localhost:3000/viewer` — filter by country/state/city, click a hotel card for full details, amenities, room list, and a photo gallery with lightbox.
- **API directly**:
  ```bash
  curl http://localhost:3000/catalog/countries
  curl "http://localhost:3000/catalog/hotels?stateId=<id>&limit=10"
  curl http://localhost:3000/catalog/hotels/<hotelId>
  ```
- **Raw DB**:
  ```bash
  docker exec -it hotelbox-scraper-postgres psql -U hotelbox -d hotelbox -c "SELECT COUNT(*) FROM master_hotel;"
  ```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `0 cities discovered` / `0 hotels found`, with a `... selector likely needs updating` log warning | Expedia's markup drifted from `expedia-selectors.ts` | Re-run the selector check (step 7), update `expedia-selectors.ts`, rebuild |
| `Blocked by Expedia anti-bot (...)` on every job | Fleet-wide anti-bot cooldown is active | Wait out `ANTI_BOT_COOLDOWN_MS` (default 30 min); don't restart workers to bypass it |
| `EADDRINUSE :::3000` on `start:api` | Another API instance is already running | Check for an existing `node dist/main.js` / `nest start` process before starting a new one |
| Jobs stuck in `waiting`, nothing progresses | No worker process running | Start `npm run start:worker` — the API process alone never scrapes |
| `/viewer` shows "No hotels match these filters" | `master_hotel` is empty for that filter combination | Confirm a scrape has actually completed hotel-detail jobs (check the dashboard), or clear filters |
