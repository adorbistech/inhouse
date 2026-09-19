import assert from "node:assert/strict";
import { test } from "node:test";
import { withMigratedApp, truncateAll, TEST_VAULT_KEY } from "./helpers.js";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";
import { getDecryptedCredentialSecret } from "../../src/services/credentialSecretAccess.js";

const sampleVendorPayload = {
  slug: "credential-vault-vendor",
  displayName: "Credential Vault Vendor",
  vendorType: "general_api",
  protocol: "custom_rest",
  baseEndpoint: "https://api.example.invalid/v1",
  billingType: "metered",
};

async function createVendorWithAccount(app: import("fastify").FastifyInstance) {
  const vendor = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
    .vendor;
  const account = (
    await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/accounts`,
      payload: { slug: "primary", displayName: "Primary Account" },
    })
  ).json().account;
  return { vendor, account };
}

test("creating a credential with a raw secret encrypts it — the response never contains the secret", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);

    const res = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/credentials`,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "sk-live-provider-secret-value" },
    });
    assert.equal(res.statusCode, 201);
    const credential = res.json().credential;

    assert.equal(credential.secretRef, null);
    assert.equal(credential.hasManagedSecret, true);
    assert.ok(typeof credential.maskedSecret === "string");
    assert.ok(!credential.maskedSecret.includes("sk-live-provider-secret-value"));
    const serialized = JSON.stringify(credential);
    assert.ok(!serialized.includes("sk-live-provider-secret-value"));
    // No ciphertext/iv/authTag/fingerprint field of any name is present.
    assert.deepEqual(
      Object.keys(credential).sort(),
      [
        "id",
        "vendorAccountId",
        "credentialType",
        "status",
        "secretRef",
        "hasManagedSecret",
        "maskedSecret",
        "createdAt",
        "updatedAt",
        "lastTestedAt",
        "lastSuccessfulAt",
      ].sort(),
    );
  });
});

test("providing both secret and secretRef is rejected; providing neither is rejected", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);

    const bothRes = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/credentials`,
      payload: {
        vendorAccountId: account.id,
        credentialType: "api_key",
        secret: "sk-live",
        secretRef: "vault://external",
      },
    });
    assert.equal(bothRes.statusCode, 400);

    const neitherRes = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/credentials`,
      payload: { vendorAccountId: account.id, credentialType: "api_key" },
    });
    assert.equal(neitherRes.statusCode, 400);
  });
});

test("a stored managed secret round-trips through the narrow decrypt boundary, using the exact raw value that was sent", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const rawSecret = "sk-live-round-trip-secret-98765";

    const res = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/credentials`,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secret: rawSecret },
    });
    const credentialId = res.json().credential.id;

    const vault = new CredentialVaultService(TEST_VAULT_KEY);
    const decrypted = await getDecryptedCredentialSecret(pool, vault, credentialId);
    assert.equal(decrypted, rawSecret);
  });
});

test("attempting to decrypt a secretRef-mode credential (no managed secret) fails cleanly", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);

    const res = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/credentials`,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secretRef: "vault://external/path" },
    });
    const credentialId = res.json().credential.id;

    const vault = new CredentialVaultService(TEST_VAULT_KEY);
    await assert.rejects(() => getDecryptedCredentialSecret(pool, vault, credentialId));
  });
});

test("rotating a credential's secret replaces the encrypted material, changes the masked value, and is recorded as vendor_credential.rotated", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);

    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/vendors/${vendor.id}/credentials`,
        payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "sk-old-secret-aaaa" },
      })
    ).json().credential;

    const rotateRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/credentials/${created.id}`,
      payload: { secret: "sk-new-secret-zzzz" },
    });
    assert.equal(rotateRes.statusCode, 200);
    const rotated = rotateRes.json().credential;
    assert.equal(rotated.hasManagedSecret, true);
    assert.notEqual(rotated.maskedSecret, created.maskedSecret);
    // The old secret never appears anywhere in the rotate response.
    assert.ok(!JSON.stringify(rotated).includes("sk-old-secret-aaaa"));
    assert.ok(!JSON.stringify(rotated).includes("sk-new-secret-zzzz"));

    // Confirm the underlying ciphertext/IV actually changed at the row level
    // (not just the masked display value) — a real re-encryption, not a no-op.
    const beforeRow = (await pool.query("SELECT secret_ciphertext, secret_iv FROM vendor_credentials WHERE id = $1", [created.id])).rows[0];

    const vault = new CredentialVaultService(TEST_VAULT_KEY);
    const decrypted = await getDecryptedCredentialSecret(pool, vault, created.id);
    assert.equal(decrypted, "sk-new-secret-zzzz");

    // Rotate a second time to confirm repeated rotation keeps working and
    // keeps using a fresh nonce/ciphertext each time.
    const secondRotateRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/credentials/${created.id}`,
      payload: { secret: "sk-third-secret-yyyy" },
    });
    assert.equal(secondRotateRes.statusCode, 200);
    const afterRow = (await pool.query("SELECT secret_ciphertext, secret_iv FROM vendor_credentials WHERE id = $1", [created.id])).rows[0];
    assert.notEqual(beforeRow.secret_ciphertext.toString("hex"), afterRow.secret_ciphertext.toString("hex"));
    assert.notEqual(beforeRow.secret_iv.toString("hex"), afterRow.secret_iv.toString("hex"));
    assert.equal(await getDecryptedCredentialSecret(pool, vault, created.id), "sk-third-secret-yyyy");

    const events = await pool.query(
      "SELECT action, metadata FROM audit_events WHERE resource_id = $1 ORDER BY created_at",
      [created.id],
    );
    const actions = events.rows.map((r) => r.action);
    assert.equal(actions.filter((a) => a === "vendor_credential.rotated").length, 2);
    for (const row of events.rows) {
      assert.ok(!JSON.stringify(row.metadata).includes("sk-old-secret-aaaa"));
      assert.ok(!JSON.stringify(row.metadata).includes("sk-new-secret-zzzz"));
      assert.ok(!JSON.stringify(row.metadata).includes("sk-third-secret-yyyy"));
    }
  });
});

test("rotating from a managed secret to an external secretRef switches modes cleanly", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);

    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/vendors/${vendor.id}/credentials`,
        payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "sk-managed-secret" },
      })
    ).json().credential;

    const switchRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/credentials/${created.id}`,
      payload: { secretRef: "vault://now-external" },
    });
    assert.equal(switchRes.statusCode, 200);
    const switched = switchRes.json().credential;
    assert.equal(switched.hasManagedSecret, false);
    assert.equal(switched.maskedSecret, null);
    assert.equal(switched.secretRef, "vault://now-external");
  });
});

test("disabling and re-enabling a credential via PATCH status records distinct audit events", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/vendors/${vendor.id}/credentials`,
        payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "sk-lifecycle-secret" },
      })
    ).json().credential;

    const disableRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/credentials/${created.id}`,
      payload: { status: "disabled" },
    });
    assert.equal(disableRes.statusCode, 200);
    assert.equal(disableRes.json().credential.status, "disabled");

    const enableRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/credentials/${created.id}`,
      payload: { status: "enabled" },
    });
    assert.equal(enableRes.statusCode, 200);
    assert.equal(enableRes.json().credential.status, "enabled");

    const events = await pool.query("SELECT action FROM audit_events WHERE resource_id = $1 ORDER BY created_at", [
      created.id,
    ]);
    const actions = events.rows.map((r) => r.action);
    assert.ok(actions.includes("vendor_credential.disabled"));
    assert.ok(actions.includes("vendor_credential.enabled"));

    // The managed secret survives a disable/enable cycle unchanged.
    const vault = new CredentialVaultService(TEST_VAULT_KEY);
    assert.equal(await getDecryptedCredentialSecret(pool, vault, created.id), "sk-lifecycle-secret");
  });
});

test("a disabled credential's secret cannot be decrypted through the narrow access boundary", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/vendors/${vendor.id}/credentials`,
        payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "sk-must-not-be-decryptable" },
      })
    ).json().credential;

    const disableRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/credentials/${created.id}`,
      payload: { status: "disabled" },
    });
    assert.equal(disableRes.statusCode, 200);

    const vault = new CredentialVaultService(TEST_VAULT_KEY);
    await assert.rejects(
      () => getDecryptedCredentialSecret(pool, vault, created.id),
      /not enabled/,
    );

    // Re-enabling restores decrypt access to the same, unchanged secret.
    await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/credentials/${created.id}`,
      payload: { status: "enabled" },
    });
    assert.equal(await getDecryptedCredentialSecret(pool, vault, created.id), "sk-must-not-be-decryptable");
  });
});

test("a managed secret is persisted as ciphertext, never plaintext, at the database layer", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const rawSecret = "sk-must-never-appear-as-plaintext-in-storage";

    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/vendors/${vendor.id}/credentials`,
        payload: { vendorAccountId: account.id, credentialType: "api_key", secret: rawSecret },
      })
    ).json().credential;

    const row = (await pool.query("SELECT * FROM vendor_credentials WHERE id = $1", [created.id])).rows[0];
    assert.ok(row.secret_ciphertext instanceof Buffer);
    assert.ok(!row.secret_ciphertext.toString("utf8").includes(rawSecret));
    assert.ok(!JSON.stringify(row).includes(rawSecret));
    assert.equal(row.secret_ref, null);
  });
});

test("the database enforces exactly one secret mode via a CHECK constraint", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { account } = await createVendorWithAccount(app);

    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_credentials (vendor_account_id, credential_type, status, secret_ref, secret_ciphertext, secret_iv, secret_auth_tag, secret_fingerprint, secret_masked, secret_encryption_version)
         VALUES ($1, 'api_key', 'enabled', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        [account.id],
      ),
    );

    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_credentials (vendor_account_id, credential_type, status, secret_ref, secret_ciphertext, secret_iv, secret_auth_tag, secret_fingerprint, secret_masked, secret_encryption_version)
         VALUES ($1, 'api_key', 'enabled', 'vault://x', '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 'fp', 'masked', 1)`,
        [account.id],
      ),
    );

    // A third, undecryptable state — some but not all encrypted-material
    // columns populated — must also be impossible, independent of secret_ref.
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_credentials (vendor_account_id, credential_type, status, secret_ref, secret_ciphertext, secret_iv, secret_auth_tag, secret_fingerprint, secret_masked, secret_encryption_version)
         VALUES ($1, 'api_key', 'enabled', NULL, '\\x00'::bytea, NULL, '\\x00'::bytea, 'fp', 'masked', 1)`,
        [account.id],
      ),
    );
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_credentials (vendor_account_id, credential_type, status, secret_ref, secret_ciphertext, secret_iv, secret_auth_tag, secret_fingerprint, secret_masked, secret_encryption_version)
         VALUES ($1, 'api_key', 'enabled', NULL, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 'fp', NULL, 1)`,
        [account.id],
      ),
    );
  });
});

test("vendor_credentials has no encryption-key column of any name", async () => {
  await withMigratedApp(async (app, pool) => {
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'inhouse' AND table_name = 'vendor_credentials'`,
    );
    const columns = result.rows.map((r) => r.column_name);
    assert.ok(!columns.some((c) => /master_key|encryption_key|vault_key/i.test(c)));
  });
});
