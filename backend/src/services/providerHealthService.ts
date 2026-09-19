import type { Pool } from "pg";
import { withTransaction } from "../db/client.js";
import { NotFoundError } from "../lib/httpErrors.js";
import { VendorAccountHealthEventsRepository } from "../repositories/vendorAccountHealthEventsRepository.js";
import { VendorAccountHealthRepository } from "../repositories/vendorAccountHealthRepository.js";
import { VendorAccountsRepository } from "../repositories/vendorAccountsRepository.js";
import type { VendorAccountHealthEventRow, VendorAccountHealthRow } from "../repositories/types.js";
import type { HealthObservationInput } from "../validation/providerHealth.js";

/**
 * Orchestrates provider-account health: records observations, maintains
 * the current-state snapshot, and serves history. Provider-agnostic by
 * construction — nothing here branches on a vendor type or provider name,
 * and nothing here makes a network call. See `providerAdapter.ts` for the
 * interface a future adapter will implement; its `checkHealth()` output
 * is exactly the shape `recordObservation()` expects.
 *
 * Deliberately does not write to `audit_events` — see migration 0012's
 * comment: health observations are frequent operational telemetry, not
 * an administrative action, and `vendor_account_health_events` is
 * already that history.
 */
export class ProviderHealthService {
  private readonly accounts: VendorAccountsRepository;
  private readonly health: VendorAccountHealthRepository;
  private readonly events: VendorAccountHealthEventsRepository;

  constructor(private readonly pool: Pool) {
    this.accounts = new VendorAccountsRepository(pool);
    this.health = new VendorAccountHealthRepository(pool);
    this.events = new VendorAccountHealthEventsRepository(pool);
  }

  private async getAccountOrThrow(vendorId: string, vendorAccountId: string) {
    const account = await this.accounts.findById(vendorAccountId);
    if (!account || account.vendor_id !== vendorId) {
      throw new NotFoundError(`Account "${vendorAccountId}" was not found for vendor "${vendorId}".`);
    }
    return account;
  }

  /**
   * Persists one observation (history) and updates the current snapshot
   * atomically. Not exposed over HTTP in Block 09 — the only callers are
   * tests and, eventually, a real provider adapter. Works the same
   * regardless of the account's administrative `status`: recording that a
   * disabled account was (un)healthy is legitimate history, not a
   * decision about whether to use it — that policy belongs to whatever
   * calls this, not to the persistence layer.
   */
  async recordObservation(
    vendorId: string,
    vendorAccountId: string,
    input: HealthObservationInput,
  ): Promise<VendorAccountHealthRow> {
    await this.getAccountOrThrow(vendorId, vendorAccountId);
    return withTransaction(this.pool, async (client) => {
      await new VendorAccountHealthEventsRepository(client).create({
        vendor_account_id: vendorAccountId,
        status: input.status,
        latency_ms: input.latencyMs,
        error_category: input.errorCategory,
        safe_error_code: input.safeErrorCode,
        source: input.source,
        checked_at: input.checkedAt,
      });

      const healthRepo = new VendorAccountHealthRepository(client);
      const current = await healthRepo.findByVendorAccountId(vendorAccountId);
      const consecutiveFailures = input.status === "unhealthy" ? (current?.consecutive_failures ?? 0) + 1 : 0;

      return healthRepo.upsert({
        vendor_account_id: vendorAccountId,
        status: input.status,
        consecutive_failures: consecutiveFailures,
        last_checked_at: input.checkedAt,
        last_success_at: input.status === "healthy" ? input.checkedAt : (current?.last_success_at ?? null),
        last_failure_at: input.status === "unhealthy" ? input.checkedAt : (current?.last_failure_at ?? null),
        last_latency_ms: input.latencyMs,
        last_error_category: input.errorCategory,
        last_safe_error_code: input.safeErrorCode,
      });
    });
  }

  /** Null means "unknown" — this account has never been observed. */
  async getCurrentHealth(vendorId: string, vendorAccountId: string): Promise<VendorAccountHealthRow | null> {
    await this.getAccountOrThrow(vendorId, vendorAccountId);
    return this.health.findByVendorAccountId(vendorAccountId);
  }

  async getHistory(vendorId: string, vendorAccountId: string, limit: number): Promise<VendorAccountHealthEventRow[]> {
    await this.getAccountOrThrow(vendorId, vendorAccountId);
    return this.events.listRecentByVendorAccountId(vendorAccountId, limit);
  }
}
