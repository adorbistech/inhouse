-- Data representation only — no routing engine or execution logic lives
-- here or anywhere in this block.
CREATE TABLE routing_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workload_id UUID NOT NULL REFERENCES workloads (id) ON DELETE CASCADE,
  tier_number INTEGER NOT NULL,
  vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  model_id UUID NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  timeout_override_ms INTEGER,
  max_attempts INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workload_id, tier_number, vendor_id, model_id)
);

CREATE TRIGGER routing_tiers_set_updated_at
  BEFORE UPDATE ON routing_tiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX routing_tiers_workload_id_idx ON routing_tiers (workload_id);
CREATE INDEX routing_tiers_vendor_id_idx ON routing_tiers (vendor_id);
CREATE INDEX routing_tiers_model_id_idx ON routing_tiers (model_id);

-- Configurable fallback conditions as data. `condition_type` names the
-- condition (e.g. "on_error", "on_timeout"); `condition_config` carries any
-- condition-specific parameters. No fallback engine evaluates these yet.
CREATE TABLE routing_fallback_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workload_id UUID NOT NULL REFERENCES workloads (id) ON DELETE CASCADE,
  from_tier_id UUID NOT NULL REFERENCES routing_tiers (id) ON DELETE CASCADE,
  to_tier_id UUID NOT NULL REFERENCES routing_tiers (id) ON DELETE CASCADE,
  condition_type TEXT NOT NULL,
  condition_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_tier_id <> to_tier_id)
);

CREATE TRIGGER routing_fallback_rules_set_updated_at
  BEFORE UPDATE ON routing_fallback_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX routing_fallback_rules_workload_id_idx ON routing_fallback_rules (workload_id);
CREATE INDEX routing_fallback_rules_from_tier_id_idx ON routing_fallback_rules (from_tier_id);
