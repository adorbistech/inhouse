# Inhouse — Deployment Foundation (Block 03, Prompt 1)

## Status

Frontend-only deployment foundation. No backend, database, worker, or
gateway exists yet. This document will grow as later blocks add those
pieces.

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

## Environment Configuration

`.env.example` at the repo root defines one variable:

```
INHOUSE_FRONTEND_PORT=8091
```

No real values, secrets, API keys, or credentials are present. `.env` is
already covered by the root `.gitignore` (`.env`, `.env.*`).

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
  from the Docker build context.

## Isolation Verification

- No file under `/root/adorbis-api`, `/opt/adorbis-gateway`,
  `/opt/ai-adorbis`, `/root/UniClaudeProxy`, `/root/gateway`,
  `/root/adorbis-intelligence`, `/etc/nginx/sites-available/*`,
  `/etc/nginx/sites-enabled/*`, PM2 config, or systemd units was written
  to.
- No existing Docker container, image, network, or volume was modified or
  removed.
- No existing service was started, stopped, or restarted, except a
  temporary, isolated test of the new `inhouse-frontend` container itself
  (built, health-checked, then stopped — see Prompt 1 test log).
