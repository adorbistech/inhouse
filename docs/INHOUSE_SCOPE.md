# Inhouse — Scope

## What Inhouse Is
Inhouse is an independent beta project, developed in its own repository and
working directory, separate from existing Adorbis systems.

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
This repository currently contains foundation documentation only. No
frontend or backend application code has been created yet.
