# Diridon Run

![test](https://github.com/<you>/diridon-run/actions/workflows/test.yml/badge.svg)
![node](https://img.shields.io/badge/node-%E2%89%A518-green)
![license](https://img.shields.io/badge/license-MIT-blue)

A departure board for one specific trip: Campus Oval → Marguerite Line P → Palo Alto Caltrain → San Jose Diridon, southbound, 2:30–7:30 PM on weekdays.

The printed timetables are the baseline. Live delay data comes from 511 SF Bay through a small proxy that holds your API token, so the token never reaches the browser.

## Setup

1. **Get a token** — free, arrives by email, usually within a few minutes: <https://511.org/open-data/token>

2. **Start it**

   ```bash
   FIVEONEONE_KEY=your-token node server.js
   ```

   Or copy `.env.example` to `.env`, fill it in, and use `node --env-file=.env server.js` (Node 20+). You can also drop the bare token into a file named `key.txt` next to `server.js`.

3. **Open** <http://localhost:8511>

Node 18 or newer. No dependencies, nothing to install.

## What runs where

| Endpoint | Source | Refresh |
|---|---|---|
| `/api/departures` | SIRI StopMonitoring at stops 70172 (Palo Alto SB) and 70262 (Diridon SB) | 120 s / 300 s cache |
| `/api/alerts` | GTFS-RT service alerts for Caltrain, requested as JSON | 600 s cache |
| `/api/health` | token status, cache ages, remaining hourly quota | — |
| Bluesky panel | `public.api.bsky.app`, read straight from the browser | 3 min |
| Reddit / X / caltrain.com | links only — they refuse cross-origin reads | — |

The dashboard polls the proxy every 60 seconds and recomputes the board every 15. If the proxy isn't running, the page still works: it falls back to the printed timetable plus the manual **Assumed delay** field, and the status strip says so.

## Staying inside the rate limit

511 allows **60 requests per hour per token**. The cache TTLs above work out to roughly 48/hour for one running instance — 30 for the Palo Alto board, 12 for Diridon, 6 for alerts. A hard counter in `server.js` stops at `HOURLY_CAP` (default 55) and serves cached data past that rather than getting throttled.

Two people running their own copy on the same token will exceed the cap. Either raise the TTLs, request a higher limit from 511, or deploy the Worker once and share it.

## How live times reach the board

For each train the proxy reports, the page uses `ExpectedDepartureTime` from the Palo Alto board and `ExpectedArrivalTime` from the Diridon board. The scheduled time gets struck through and the live time shown beside it, and the Line P connection is re-picked against the new departure time — so a late train may open up a later shuttle you can still make.

Trains 511 hasn't reported yet (typically anything more than an hour out) fall back to the **Assumed delay** field. Delay figures parsed out of an alert or a Bluesky post get a one-click button to set that field.

Matching a live record to a train uses `VehicleRef` or the trip reference first, then falls back to matching the aimed time against the printed timetable within 3 minutes. Both paths are covered in `test.js`.

## Verify the stop codes

Codes can change when Caltrain republishes its GTFS. If live times stop appearing:

```bash
FIVEONEONE_KEY=your-token node find-stops.js
```

That lists every Caltrain stop matching Palo Alto or Diridon with its current code. Set `STOP_DEP` and `STOP_ARR` accordingly.

## Tests

```bash
node test.js
```

Runs fully offline against a mocked 511 API — checks BOM handling (511 prefixes its JSON with one), train-number extraction, the aimed-time fallback, both-stop merging, cache behavior, and each endpoint.

## Hosting it instead

`worker.js` is the same proxy as a Cloudflare Worker, so the board works from a phone with no laptop running:

```bash
npx wrangler secret put FIVEONEONE_KEY
npx wrangler deploy
```

Then set `API_BASE` in the dashboard to the Worker URL and prefix the two `/api/...` fetches with it. Header comments in `worker.js` have the `wrangler.toml`.

## When the schedule changes

Both timetables are plain arrays. `TRAINS` and `LINEP` near the top of the script block in `diridon_run.html`, and `SCHEDULE` in `server.js` and `worker.js` — the server copy is only used for matching live records to trains, so keep the Caltrain times identical across files.

Current baselines: Line P PM weekday sheet effective 1/27/2025; Caltrain weekday schedule effective 1/31/2026. Line P doesn't run on university holidays.

## Keeping the token out of the repo

`.gitignore` covers `.env` and `key.txt`, and nothing in the committed code contains a token. Two things to know:

- The proxy answers requests with your token attached, so `server.js` binds `127.0.0.1` by default. Set `HOST=0.0.0.0` only when you actually want it reachable from your phone on the same network.
- `ALLOW_ORIGIN` in the Worker defaults to `*`, which would let anyone who finds the URL spend your hourly quota. Set it to your page's origin before deploying anything public.

If a token ever lands in a commit, rotating it is the fix — deleting the line in a later commit does not remove it from history. Request a replacement at the token link above.

## Attribution

511 requires that 511.org be credited as the data provider. The dashboard footer and the API `meta.attribution` fields do this; keep them if you redistribute.
