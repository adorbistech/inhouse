-- Inhouse-issued API keys, NOT provider credentials. The raw key is never
-- persisted — only a one-way hash (see src/lib/apiKeyHash.ts). Authentication
-- itself is not implemented until a later block; this table only provides
-- the persistence boundary for it.
CREATE TABLE inhouse_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX inhouse_api_keys_status_idx ON inhouse_api_keys (status);
