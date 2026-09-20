# Inhouse live E2E (Block 13) — TEST ONLY

Nothing here is part of the production deployment. `docker-compose.yml` does not
reference this directory.

- `mock-provider/` — dependency-free OpenAI-compatible mock (`/v1/models`,
  `/v1/chat/completions`). Scenario is chosen by the provider-facing model id
  (`mock-ok`, `mock-tools`, `mock-retry-once`, `mock-fail-503|400|401|429`,
  `mock-slow`, `mock-stream-idle`, `mock-stream-flood`), i.e. by a `models` row
  in the Inhouse database — no routing logic lives in Inhouse. Records
  per-request metadata at `/_mock/log` (never message content or the raw
  secret; only a SHA-256 prefix of the bearer).
- `docker-compose.e2e.yml` — overlay that runs the mock on `inhouse-net` only,
  with **no published port**.
- `run-e2e.mjs` — seeds disposable `b13-<run>-*` data (via the API through the
  frontend `/v1` proxy; workloads via SQL because no workload-create endpoint
  exists), exercises auth, unary, streaming, tools, retry, fallback,
  cancellation, provider failures, restart persistence and a secret/log scan,
  then deletes only its own prefix.

```
docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml up -d --build inhouse-mock-provider
node e2e/run-e2e.mjs            # add --keep to leave the data in place
docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml rm -sf inhouse-mock-provider
```

Only the mock's test credential is ever used. Not covered live: the 600 s
absolute stream-duration cap (unit-tested only).
