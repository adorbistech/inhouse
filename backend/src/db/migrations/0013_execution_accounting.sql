-- Block 12 (Execution & Claude Integration) extends the existing Block 08
-- usage_ledger table (migration 0008, unchanged otherwise) with the
-- correlation/attempt fields real execution needs. Still one row per
-- logical client execution (never per attempt) — these columns only let a
-- caller correlate a row back to a specific request/execution and see how
-- many attempts it took. No new ledger or routing table.
ALTER TABLE usage_ledger
  ADD COLUMN execution_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN request_id TEXT,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN provider_request_id TEXT;

CREATE INDEX usage_ledger_execution_id_idx ON usage_ledger (execution_id);
