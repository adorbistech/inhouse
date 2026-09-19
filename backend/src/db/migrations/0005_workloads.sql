CREATE TABLE workloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER workloads_set_updated_at
  BEFORE UPDATE ON workloads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE model_workloads (
  model_id UUID NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  workload_id UUID NOT NULL REFERENCES workloads (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, workload_id)
);

CREATE INDEX model_workloads_workload_id_idx ON model_workloads (workload_id);
