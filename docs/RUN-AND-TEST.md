# Run & Test — Clearance one-command stack

## One-command run

Requirements: Docker (daemon running) and nothing else — no local Node or
Postgres needed.

```bash
cp .env.example .env
# Edit .env: at minimum set CLEARANCE_ACCESS_PASSWORD to a long random value.
# The backend refuses to boot in production on the CHANGEME placeholder.
docker compose up --build
```

What comes up (in order):

| Service  | Address               | Notes                                              |
|----------|-----------------------|----------------------------------------------------|
| db       | internal only         | Postgres 16, must be `healthy` first              |
| backend  | http://localhost:3001 | runs `prisma migrate deploy`, then serves the API |
| frontend | http://localhost:8080 | built Vite bundle on nginx, SPA fallback enabled   |

Open **http://localhost:8080** in a browser. API keys (BYOK) are entered in
the app Settings page — no secrets are baked into any image (`.env` stays
gitignored; never commit it).

## Verify it works

```bash
docker compose config            # validates with zero errors (no daemon needed)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health   # expect 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/           # expect 200
```

Deep link check (SPA fallback): `curl http://localhost:8080/jobs` should
return HTTP 200 with the app shell, not a 404.

Stop everything:

```bash
docker compose down
```

## Troubleshooting: backend restart-loops / can't reach the database

If the root `.env` sets `DATABASE_URL` to `localhost:5433` (the host-side
embedded-Postgres dev default), the backend container cannot reach it —
`localhost` inside a container is the container itself, not your host. Start
with a CLI-only override (does not modify `.env`) or comment that line out
of `.env` so the compose default (`db:5432`) applies:

```bash
DATABASE_URL=postgresql://postgres:postgres@db:5432/clearance?schema=public docker compose up --build
```

## Changing frontend config

Vite bakes `VITE_*` values into the bundle **at build time**. After editing
any `VITE_*` variable in the root `.env`, rebuild:

```bash
docker compose up --build
```

`VITE_API_URL` must stay host-reachable from the browser (default
`http://localhost:3001/api`) — not `http://backend:3001/api`, which only
resolves inside compose networking and is unreachable from a browser.

## Browser tier opt-in (unchanged)

The default image stays slim (`WITH_BROWSER=false`): deep search reports the
browser tier as skipped-with-reason. Full image:

```bash
WITH_BROWSER=true docker compose up --build
```

then `CAMOUFOX_ENABLED=true` in `.env`. See README for the remote-endpoint
shape.

## Local dev (no Docker)

Unchanged: `cd backend && npm run db:local` (embedded Postgres on :5433),
`cd backend && npm run dev` (:3001), `npm run dev` at root (:8080).
