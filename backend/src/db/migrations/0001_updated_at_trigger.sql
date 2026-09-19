-- Shared trigger function that keeps `updated_at` current on every UPDATE.
-- Applied per-table by later migrations that define an updated_at column.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
