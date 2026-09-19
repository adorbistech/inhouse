-- Block 09: Provider Account & Health Foundation.
--
-- `vendor_accounts` (Block 05) already represents provider account
-- identity — this migration does not touch it or add columns to it; the
-- existing id/slug/display_name/status/external_account_ref/timestamps
-- are sufficient. What's missing is a place to record *observed*
-- operational health, which is deliberately a separate concept from the
-- administrative `status` column: `status` is operator intent (should
-- this account be used), health is an observed fact (is it working).
-- Conflating the two would be exactly the "overlapping status systems"
-- this migration avoids.
--
-- Two tables:
-- - `vendor_account_health` — one row per account, the current computed
--   snapshot (upserted on every observation).
-- - `vendor_account_health_events` — append-only history of individual
--   observations. Deliberately not written to `audit_events`: that table
--   is for administrative actions; health observations are frequent
--   operational telemetry, not an operator action.
--
-- Neither table has a raw-error/metadata blob column by design — see
-- docs/PROVIDER_HEALTH.md. `status`/`error_category` stay plain TEXT
-- (validated at the application layer), matching this schema's existing
-- convention for status-like columns (see docs/DATABASE.md).
CREATE TABLE vendor_account_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_account_id UUID NOT NULL UNIQUE REFERENCES vendor_accounts (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_latency_ms INTEGER,
  last_error_category TEXT,
  last_safe_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (consecutive_failures >= 0),
  CHECK (last_latency_ms IS NULL OR last_latency_ms >= 0)
);

CREATE TRIGGER vendor_account_health_set_updated_at
  BEFORE UPDATE ON vendor_account_health
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vendor_account_health_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_account_id UUID NOT NULL REFERENCES vendor_accounts (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  error_category TEXT,
  safe_error_code TEXT,
  source TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

-- Justified by the one real access pattern this block establishes:
-- "most recent N observations for this account."
CREATE INDEX vendor_account_health_events_account_checked_idx
  ON vendor_account_health_events (vendor_account_id, checked_at DESC);
