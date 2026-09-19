# Inhouse — Deployment Foundation (Block 03, extended in Block 04, Block 05, and Block 06)

## Status

Frontend, backend/API, and database deployment foundations exist. See
`docs/API.md` for the backend's API contract (including the Block 06
Vendor System) and `docs/DATABASE.md` for the persistence foundation
added in Block 05 and extended in Block 06.

**Block 06 made no deployment/Docker changes** — no new service, port,
network, or volume. It only added application code (routes, a schema
migration) on top of the Block 03–05 deployment foundation, which is
unchanged.

## VPS Discovery (read-only, recorded at time of Block 03 Prompt 1)

- OS: Ubuntu 24.04.4 LTS, kernel 6.8.0-138-generic
- Node.js: v22.23.2 / npm 10.9.8 (host)
- Docker: 29.4.1, Docker Compose v5.1.3
- Nginx: 1.24.0 (Ubuntu), config test passes (`nginx -t`)

### Ports already in use on the host

| Port | Bind | Owner |
|---|---|---|
| 22 | 0.0.0.0 / [::] | sshd |
| 80, 443, 8443 | 0.0.0.0 / [::] | nginx (existing Adorbis sites) |
| 3000 | 0.0.0.0 | node (`timespace`, PM2) |
| 4000 | 127.0.0.1 | node (`adorbis-api`, PM2) |
| 5432 | 127.0.0.1 / [::1] | postgresql (host service) |
| 5433 | 127.0.0.1 | docker-proxy → `adorbis-core-test-postgres` |
| 5678, 5679 | 0.0.0.0 / [::] | docker-proxy → n8n containers |
| 5680 | 127.0.0.1 | docker-proxy → `adorbis-n8n` |
| 6333, 6334 | 127.0.0.1 | docker-proxy → `adorbis-qdrant` |
| 8080 | 127.0.0.1 | docker-proxy → `adorbis-tei` |
| 8090 | 0.0.0.0 | python3 (existing service) |
| 11434 | 127.0.0.1 | ollama |
| 44773 | 127.0.0.1 | llama-server |

**Port selected for INHOUSE frontend: `8091`**, bound to `127.0.0.1` only.
Confirmed free via `ss -tln` before use. Not exposed publicly — see
"Domain / Network" below.

**Port selected for INHOUSE API (Block 04): `8092`**, bound to `127.0.0.1`
only. Re-confirmed free via `ss -tln` immediately before use.

### Existing Nginx server blocks (untouched)

`sites-enabled`: `default`, `ai.adorbistech.com`, `aichat` (`open-webui.conf`),
`api.adorbistech.com`, `adorbis-immersive`, `gf.adorbistech.com`,
`indiaone-api`, `indiaone-ssl`, `n8n`, `new.adorbistechnology.com`,
`timespace`, `workspace-adorbistech`. No `inhouse` or `api.inhouse` site
exists. None of these files were modified.

### Existing PM2 processes (untouched)

`adorbis-api` (port 4000), `timespace` (port 3000).

### Existing Docker containers (untouched)

`adorbis-core-test-postgres`, `n8n`, `guerrilla-fare-n8n-n8n-1`,
`guerrilla-fare-n8n-postgres-1`, `adorbis-n8n`, `adorbis-tei`,
`adorbis-qdrant`. Existing Docker networks: `adorbis-core-test-net`,
`adorbis-n8n_adorbis-vi-net`, `guerrilla-fare-n8n_default`, `bridge`,
`host`, `none`. INHOUSE uses its own dedicated network (`inhouse-net`),
created fresh — no existing network was joined or altered.

### Existing systemd services (untouched)

`adorbis-adapter`, `adorbis-gateway-prod`, `adorbis-multimodal-monitor`,
`docker`, `nginx`, `ollama` / `ollama-preload`, `postgresql` /
`postgresql@16-main`. None were started, stopped, or reconfigured.

## Domain / Network

- `inhouse.adorbistech.com` and `api.inhouse.adorbistech.com` currently have
  **no DNS records** (`dig` returns empty for both). No DNS was invented or
  assumed.
- `adorbistech.com` apex currently resolves to `185.230.63.107/171/186`,
  which is **not** this VPS's address (`72.60.203.37`). Existing
  `*.adorbistech.com` subdomains that are live on this VPS (e.g.
  `ai.adorbistech.com`, `api.adorbistech.com`) must therefore have their own
  A/AAAA records pointing here — the apex record does not control them.
  `inhouse.adorbistech.com` will need an equivalent dedicated A/AAAA record
  once someone with DNS access creates it.
- Because DNS is not yet configured, **no Nginx server block was added**
  for `inhouse.adorbistech.com` in this prompt. Adding a host Nginx vhost
  now would be non-functional (nothing resolves to it) and premature per
  the Block 03 scope. This is deferred to a later prompt once DNS exists —
  at that point a new, isolated `sites-available/inhouse.adorbistech.com`
  file can be added (proxying to `127.0.0.1:8091`) without touching any
  existing server block.

## Deployment Architecture Selected: Docker Compose

**Why Docker Compose (over a dedicated systemd service or another
mechanism):**

- The VPS already runs Docker (29.4.1) with several isolated
  application containers (n8n, qdrant, tei, postgres-test) — this is the
  established pattern for isolated, containerized services here, distinct
  from the PM2-managed bare-node processes (`adorbis-api`, `timespace`).
- A container gets its own filesystem and process namespace, so the
  INHOUSE frontend cannot collide with or be confused for an existing PM2
  app or systemd unit.
- `docker compose up -d` / `down` gives independent start/stop without
  touching PM2's process list or any systemd unit file.
- Reproducible: the entire runtime is defined in
  `docker-compose.yml` + `frontend/Dockerfile`, checked into Git.

## Frontend Deployment

- Multi-stage `frontend/Dockerfile`:
  1. `node:22-alpine` — `npm ci` + `npm run build` (existing Vite build,
     unchanged — no new frontend framework, no UI changes).
  2. `nginx:1.27-alpine` — serves the static `dist/` output only. This is a
     container-internal Nginx instance, entirely separate from the host's
     `/etc/nginx` — no shared files, no shared config, no reload of the
     host Nginx service.
- `frontend/nginx.conf` (container-only) serves the SPA with a
  `try_files ... /index.html` fallback for client-side routing, plus a
  `/healthz` location.
- `frontend/public/healthz` is a static `ok` file. Vite copies files under
  `public/` to the build output root as-is, so this required no
  application/source code change — just one static asset, which is the
  narrow, explicit Block 03 exception to "don't modify the Block 02
  baseline."

## Backend/API Deployment (Block 04)

- `backend/` is a TypeScript + Fastify service, provider-neutral and
  database-free at this stage. Full API contract in `docs/API.md`.
- Multi-stage `backend/Dockerfile`: `node:22-alpine` builds
  (`npm ci && npm run build`), then a second `node:22-alpine` stage runs
  `npm ci --omit=dev` and starts `node dist/server.js` — no build tooling
  ships in the runtime image.
- Docker Compose gained a second, independent service: `inhouse-api`
  (container `inhouse-api`), on the same dedicated `inhouse-net` network as
  `inhouse-frontend` so the two can reach each other by container name in a
  later block — no functional wiring between them exists yet.
- Published to the host as `127.0.0.1:${INHOUSE_API_PORT:-8092}` only, same
  loopback-only pattern as the frontend.
- Docker `HEALTHCHECK` uses a Node one-liner (`node -e ...` hitting
  `GET /health`) rather than `wget`/`curl`, since the `node:22-alpine`
  runtime image includes neither.

## Environment Configuration

`.env.example` at the repo root defines:

```
INHOUSE_FRONTEND_PORT=8091
INHOUSE_API_PORT=8092
INHOUSE_API_ENV=production
INHOUSE_API_LOG_LEVEL=info
INHOUSE_API_CORS_ORIGINS=
```

No real values, secrets, API keys, or credentials are present. `.env` is
already covered by the root `.gitignore` (`.env`, `.env.*`). The API's own
configuration variables are documented in full in `docs/API.md`.

## Health / Operability

- **Build succeeds:** `docker compose build` runs `npm ci && npm run
  build` inside the container from a clean `node_modules`.
- **Running:** `docker compose up -d` starts the `inhouse-frontend`
  container.
- **Healthy:** Docker `HEALTHCHECK` (`wget` against
  `http://localhost/healthz` inside the container) reports `healthy`
  after `docker compose ps`.
- **Reachable:** `curl http://127.0.0.1:8091/healthz` returns `ok` from
  the host once the container is up.
- **Stoppable independently:** `docker compose down` removes the
  container and the dedicated `inhouse-net` network without affecting any
  other container, network, PM2 process, or systemd unit.
- **Backend verified the same way (Block 04):** `docker compose build
  inhouse-api` and `docker compose up -d inhouse-api` succeeded;
  `GET /health`, `/v1/health`, `/ready` all returned 200 with the
  documented deterministic payloads; an unknown route returned the
  standard `{error:{code,message,requestId}}` 404 shape; the Docker
  `HEALTHCHECK` reported `healthy`. PM2 restart counts
  (`adorbis-api`: 12, `timespace`: 1) and the existing Docker container
  list were identical before and after the test. `docker compose down`
  then removed `inhouse-api` and `inhouse-net` cleanly.

## Database (Block 05)

- Docker Compose gained a third service: `inhouse-postgres` (image
  `postgres:16-alpine`), on the same `inhouse-net` network, with a
  dedicated named volume (`inhouse-postgres-data`) and a `pg_isready`
  healthcheck. **No host port is published** — `inhouse-api` reaches it
  only via Docker DNS (`inhouse-postgres:5432`). `inhouse-api` now
  `depends_on: inhouse-postgres` with `condition: service_healthy`.
- Full detail (schema, migrations, isolation rationale, repositories,
  credential/API-key hashing boundaries, test database isolation) is in
  `docs/DATABASE.md`.
- **Verified:** `docker compose build inhouse-api` succeeded with the new
  `pg` dependency bundled; an isolated `docker compose up -d
  inhouse-postgres inhouse-api` (temporary env file, never committed)
  brought both containers to `healthy`; `GET /health`, `/v1/health`,
  `/ready` still returned the unchanged Block 04 payloads; the compiled
  `dist/db/migrate.js` (run via a throwaway `node:22-alpine` container
  attached to `inhouse-net`, no source or dev tooling needed) applied all
  9 migrations against `inhouse-postgres` and reported them repeat-safe on
  a second run. `docker compose down` then removed `inhouse-api`,
  `inhouse-postgres`, and `inhouse-net`; the test-created
  `inhouse-postgres-data` volume was removed manually afterward, since
  `compose down` does not remove named volumes by default. PM2 restart
  counts (`adorbis-api`: 12, `timespace`: 1) and the existing Docker
  container list were identical before and after.

## Security Verification

- `.env`, `*.pem`, `*.key`, `secrets/`, `credentials/`, `node_modules/`,
  `dist/`, `build/`, logs, and local databases are all ignored by the
  existing root `.gitignore` (verified — no changes needed).
- No `.env` file was created, only `.env.example` with placeholder-only
  content.
- No provider API keys, vendor secrets, or database passwords appear
  anywhere in the new files.
- No existing Adorbis configuration, credentials, or source files were
  read into or copied into this repository.
- `frontend/.dockerignore` excludes `node_modules`, `dist`, and `.git`
  from the Docker build context; `backend/.dockerignore` does the same plus
  `test/`.
- Backend secret scan (Block 04): no API keys, provider credentials,
  passwords, tokens, or database credentials found anywhere under
  `backend/`. No provider SDK dependency was added (Fastify + its own
  `@fastify/cors`/`@fastify/helmet` plugins only).
- Backend secret scan (Block 05): no plaintext database password, API key,
  or vendor secret found anywhere under `backend/src` or `backend/test`.
  `INHOUSE_DB_PASSWORD` has no default anywhere in source — a missing
  value fails startup. `.env.example` only gained placeholder-style
  entries (no real host, credential, or value). The disposable test
  database's password (`backend/scripts/testDb.ts`) is a fixed,
  clearly-labeled non-secret string scoped to a container that only ever
  exists on loopback for the duration of `npm run test:db`.

## Isolation Verification

- No file under `/root/adorbis-api`, `/opt/adorbis-gateway`,
  `/opt/ai-adorbis`, `/root/UniClaudeProxy`, `/root/gateway`,
  `/root/adorbis-intelligence`, `/etc/nginx/sites-available/*`,
  `/etc/nginx/sites-enabled/*`, PM2 config, or systemd units was written
  to.
- No existing Docker container, image, network, or volume was modified or
  removed.
- No existing service was started, stopped, or restarted, except temporary,
  isolated tests of the new `inhouse-frontend` (Block 03), `inhouse-api`
  (Block 04), and `inhouse-postgres`/`inhouse-postgres-test` (Block 05)
  containers themselves — each built, health-checked, then stopped and
  removed along with the dedicated `inhouse-net` network (see the Prompt 1
  test logs in each block's section above).
- Block 05's DB-backed test suite (`npm run test:db`) never connects to
  the host's PostgreSQL or to `adorbis-core-test-postgres` — it only ever
  talks to a disposable `inhouse-postgres-test` container on a
  Docker-assigned, loopback-only port, torn down by `npm run test:db:stop`
  (verified: no `inhouse-*` container, network, or volume remained after
  the test run completed).
