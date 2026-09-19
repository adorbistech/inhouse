-- `metadata` is caller-supplied JSON and must never contain secrets;
-- repositories/services are responsible for keeping it secret-free before
-- it reaches this table (see docs/DATABASE.md).
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_created_at_idx ON audit_events (created_at);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id);
