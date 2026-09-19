CREATE TABLE models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  provider_model_id TEXT NOT NULL,
  inhouse_alias TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  context_window INTEGER,
  status TEXT NOT NULL DEFAULT 'inactive',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, provider_model_id)
);

CREATE TRIGGER models_set_updated_at
  BEFORE UPDATE ON models
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX models_vendor_id_idx ON models (vendor_id);

CREATE TABLE capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER capabilities_set_updated_at
  BEFORE UPDATE ON capabilities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE model_capabilities (
  model_id UUID NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  capability_id UUID NOT NULL REFERENCES capabilities (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, capability_id)
);

CREATE INDEX model_capabilities_capability_id_idx ON model_capabilities (capability_id);
