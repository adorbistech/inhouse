-- No pricing calculation and no provider pricing seeds happen here — this
-- table only persists what a later block computes/records.
CREATE TABLE usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inhouse_api_key_id UUID REFERENCES inhouse_api_keys (id) ON DELETE SET NULL,
  vendor_id UUID REFERENCES vendors (id) ON DELETE SET NULL,
  vendor_account_id UUID REFERENCES vendor_accounts (id) ON DELETE SET NULL,
  model_id UUID REFERENCES models (id) ON DELETE SET NULL,
  workload_id UUID REFERENCES workloads (id) ON DELETE SET NULL,
  primary_tier_id UUID REFERENCES routing_tiers (id) ON DELETE SET NULL,
  fallback_tier_id UUID REFERENCES routing_tiers (id) ON DELETE SET NULL,
  is_fallback BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  error_category TEXT,
  provider_cost NUMERIC(18, 6),
  inhouse_cost NUMERIC(18, 6),
  currency TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX usage_ledger_created_at_idx ON usage_ledger (created_at);
CREATE INDEX usage_ledger_inhouse_api_key_id_idx ON usage_ledger (inhouse_api_key_id);
CREATE INDEX usage_ledger_vendor_id_idx ON usage_ledger (vendor_id);
CREATE INDEX usage_ledger_model_id_idx ON usage_ledger (model_id);
