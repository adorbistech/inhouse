-- Block 12 (Execution & Claude Integration): client API keys are scoped to
-- the workloads they may execute against. Default deny — a key with no rows
-- here can execute nothing. This is a distinct edge (key -> workload) from
-- vendor_workloads/model_workloads (which say what a workload may be
-- *served by*); it says who may *request* a workload, so an application key
-- can never be pointed at a coding-agent workload (and vice versa) merely
-- by naming a different workloadId. Data-driven: references the existing
-- workloads table by id, no provider or workload names anywhere.
CREATE TABLE inhouse_api_key_workloads (
  api_key_id UUID NOT NULL REFERENCES inhouse_api_keys (id) ON DELETE CASCADE,
  workload_id UUID NOT NULL REFERENCES workloads (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, workload_id)
);

CREATE INDEX inhouse_api_key_workloads_workload_id_idx ON inhouse_api_key_workloads (workload_id);
