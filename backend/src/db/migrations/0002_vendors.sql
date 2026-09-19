CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  vendor_type TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_endpoint TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  billing_type TEXT NOT NULL,
  default_tier INTEGER,
  max_tier INTEGER,
  automatic_fallback BOOLEAN NOT NULL DEFAULT false,
  timeout_ms INTEGER,
  retry_max_attempts INTEGER,
  retry_backoff_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER vendors_set_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX vendors_status_idx ON vendors (status);
