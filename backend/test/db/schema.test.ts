import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { withMigratedPool, truncateAll } from "./helpers.js";
import { VendorsRepository } from "../../src/repositories/vendorsRepository.js";

test("a vendor_account referencing a non-existent vendor is rejected (foreign key)", async () => {
  await withMigratedPool(async (pool) => {
    await assert.rejects(
      () =>
        pool.query(`INSERT INTO vendor_accounts (vendor_id, slug, display_name, status) VALUES ($1, $2, $3, $4)`, [
          randomUUID(),
          "acct",
          "Account",
          "inactive",
        ]),
      /foreign key/i,
    );
  });
});

test("deleting a vendor cascades to its dependent vendor_accounts", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);

    const vendors = new VendorsRepository(pool);
    const vendor = await vendors.create({
      slug: "cascade-vendor",
      display_name: "Cascade Vendor",
      vendor_type: "llm",
      protocol: "https",
      base_endpoint: "https://example.invalid",
      description: null,
      status: "active",
      billing_type: "metered",
      default_tier: 1,
      max_tier: 1,
      automatic_fallback: false,
      timeout_ms: 5000,
      retry_max_attempts: 1,
      retry_backoff_ms: 100,
    });

    await pool.query(`INSERT INTO vendor_accounts (vendor_id, slug, display_name, status) VALUES ($1, $2, $3, $4)`, [
      vendor.id,
      "acct-1",
      "Account 1",
      "active",
    ]);

    await pool.query(`DELETE FROM vendors WHERE id = $1`, [vendor.id]);

    const remaining = await pool.query(`SELECT * FROM vendor_accounts WHERE vendor_id = $1`, [vendor.id]);
    assert.equal(remaining.rows.length, 0);
  });
});

test("vendor slugs must be unique", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);

    const vendors = new VendorsRepository(pool);
    const newVendor = {
      slug: "duplicate-vendor",
      display_name: "Vendor",
      vendor_type: "llm",
      protocol: "https",
      base_endpoint: "https://example.invalid",
      description: null,
      status: "active",
      billing_type: "metered",
      default_tier: 1,
      max_tier: 1,
      automatic_fallback: false,
      timeout_ms: null,
      retry_max_attempts: null,
      retry_backoff_ms: null,
    };

    await vendors.create(newVendor);
    await assert.rejects(() => vendors.create(newVendor), /duplicate key|unique/i);
  });
});
