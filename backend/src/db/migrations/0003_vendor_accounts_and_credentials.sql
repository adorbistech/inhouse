CREATE TABLE vendor_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  external_account_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, slug)
);

CREATE TRIGGER vendor_accounts_set_updated_at
  BEFORE UPDATE ON vendor_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX vendor_accounts_vendor_id_idx ON vendor_accounts (vendor_id);

-- Metadata/reference only. Never store a plaintext provider secret in this
-- table (or anywhere in this schema). `secret_ref` points at an external
-- vault entry; the vault/encryption mechanism itself belongs to a later
-- block. This table exists so credential lifecycle (status, last tested)
-- can be tracked without the secret ever touching this database.
CREATE TABLE vendor_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_account_id UUID NOT NULL REFERENCES vendor_accounts (id) ON DELETE CASCADE,
  credential_type TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tested_at TIMESTAMPTZ,
  last_successful_at TIMESTAMPTZ
);

CREATE TRIGGER vendor_credentials_set_updated_at
  BEFORE UPDATE ON vendor_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX vendor_credentials_vendor_account_id_idx ON vendor_credentials (vendor_account_id);
