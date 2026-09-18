# Inhouse — Development Rules

## Boundaries
- All Inhouse work happens only inside `/root/inhouse`.
- Existing Adorbis systems are read-only and must not be touched (no edits,
  restarts, reloads, migrations, or config changes) as part of Inhouse work.
- No code may be copied from existing Adorbis repositories into this
  repository.

## Secrets and Credentials
- No secrets, API keys, or credentials are ever committed to this
  repository.
- Provider credentials must remain backend-only, never exposed to the
  frontend or client-side code.

## Configuration
- Future configuration must be data-driven, not hardcoded.

## Process
- Future work is implemented block-by-block.
- Each block is tested before moving on to the next block.
- No build, install, or application code is introduced until explicitly
  scoped for that block.
