# Inhouse — Scope

## What Inhouse Is
Inhouse is an independent beta project, developed in its own repository and
working directory, separate from existing Adorbis systems. It is the
**Inhouse Coding API**: an isolated, Adorbis-controlled compatibility,
routing and execution layer for developer clients (Claude Code and Claude
Desktop Developer Mode). Provider credentials stay behind Inhouse.

- **GitHub repository:** `adorbistech/inhouse`
- **Working directory:** `/root/inhouse`

## Relationship to Existing Adorbis Systems
Existing Adorbis systems (e.g. `/root/adorbis-api`, existing Adorbis
repositories, nginx, Docker, PostgreSQL, Redis, systemd configuration) are
**read-only reference/baseline** for Inhouse work.

- They must not be modified, restarted, reloaded, migrated, or reconfigured
  as part of Inhouse work.
- No code from existing Adorbis repositories may be copied into this
  repository.

## Foundation Principles
- No secrets are ever committed to this repository.
- Provider credentials remain backend-only and are never exposed to the
  frontend or committed to source control.
- Future configuration is data-driven rather than hardcoded.
- Future work is implemented block-by-block, with each block tested before
  moving on to the next.

## Current Status
The repository contains a working backend API (`backend/`), an admin
frontend control plane (`frontend/`), a Docker Compose deployment
(`docker-compose.yml`), and a test-only mock-provider E2E harness (`e2e/`).
Blocks 0 through 14D are complete and locked.

The authoritative definition of what Beta must prove, and how it is
certified, is [BETA_ACCEPTANCE.md](BETA_ACCEPTANCE.md). Nothing in this
repository is declared Beta-certified until the sign-off criteria in that
document are met.

Per-area behavior is documented in `EXECUTION.md`, `ROUTING_POLICY.md`,
`PROVIDER_ADAPTERS.md`, `PROVIDER_HEALTH.md`, `CREDENTIAL_VAULT.md`,
`API.md`, `DATABASE.md` and `DEPLOYMENT.md`.
