-- Block 06 (Vendor System) schema extension.
--
-- Why this extension is required: the Block 05 schema already models
-- capability/workload assignment at the MODEL level (model_capabilities,
-- model_workloads), but the Vendor System needs vendor-level capability
-- and workload assignment (which capabilities a vendor advertises, which
-- workloads it is allowed to serve) — a distinct edge, not a duplicate of
-- the model-level one. It also needs a vendor-level `priority` and the
-- specific per-condition retry flags the Vendor System's routing-adjacent
-- configuration (not routing execution — Block 06 does not implement
-- routing) requires. Nothing here duplicates an existing table; it only
-- adds columns to `vendors` and two new join tables that reference the
-- existing `capabilities` and `workloads` reference tables.
ALTER TABLE vendors
  ADD COLUMN priority INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN retry_on_timeout BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN retry_on_rate_limit BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN retry_on_5xx BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN retry_on_auth_failure BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN retry_on_invalid_response BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE vendor_capabilities (
  vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  capability_id UUID NOT NULL REFERENCES capabilities (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, capability_id)
);

CREATE INDEX vendor_capabilities_capability_id_idx ON vendor_capabilities (capability_id);

CREATE TABLE vendor_workloads (
  vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  workload_id UUID NOT NULL REFERENCES workloads (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, workload_id)
);

CREATE INDEX vendor_workloads_workload_id_idx ON vendor_workloads (workload_id);
