import type { Pool } from "pg";
import { NotFoundError } from "../lib/httpErrors.js";
import type { VendorAccountHealthRow, VendorAccountRow, VendorCredentialRow, VendorRow } from "../repositories/types.js";
import { VendorAccountsRepository } from "../repositories/vendorAccountsRepository.js";
import { VendorCredentialsRepository } from "../repositories/vendorCredentialsRepository.js";
import { VendorsRepository } from "../repositories/vendorsRepository.js";
import type { AdapterRegistry } from "./adapters/adapterRegistry.js";
import { ProviderHealthService } from "./providerHealthService.js";

export const ACCOUNT_READINESS_STATES = [
  "disabled",
  "unsupported",
  "missing_credential",
  "unverified",
  "unhealthy",
  "ready",
] as const;
export type AccountReadiness = (typeof ACCOUNT_READINESS_STATES)[number];

export type AccountReadinessReason =
  | "vendor_not_enabled"
  | "account_not_enabled"
  | "no_adapter_for_protocol"
  | "no_enabled_credential"
  | "credential_not_usable"
  | "never_verified"
  | "last_check_unhealthy"
  | "last_check_healthy"
  | "last_check_degraded";

export interface AccountReadinessResult {
  readiness: AccountReadiness;
  reason: AccountReadinessReason;
  vendorId: string;
  vendorAccountId: string;
  vendorStatus: string;
  accountStatus: string;
  adapterSupported: boolean;
  credential: {
    present: boolean;
    enabled: boolean;
    usable: boolean;
    lastTestedAt: Date | null;
    lastSuccessfulAt: Date | null;
  };
  health: {
    status: string;
    lastCheckedAt: Date | null;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    consecutiveFailures: number;
    lastLatencyMs: number | null;
    lastErrorCategory: string | null;
    lastSafeErrorCode: string | null;
  };
}

export interface AccountReadinessInput {
  vendor: Pick<VendorRow, "id" | "status">;
  account: Pick<VendorAccountRow, "id" | "status">;
  credentials: VendorCredentialRow[];
  adapterSupported: boolean;
  health: VendorAccountHealthRow | null;
}

/**
 * The credential a verification or execution attempt would pick: the
 * first `enabled` credential ordered by `created_at` ascending, with `id`
 * as a stable tie-break. This mirrors what `executionService` and
 * `providerVerificationService` do today (both take the first enabled row
 * of `listByVendorAccountId`, which orders by `created_at`); it is
 * documented and made deterministic here without changing either of them.
 * A disabled credential is never a candidate, even if it is older.
 */
export function selectCandidateCredential(credentials: VendorCredentialRow[]): VendorCredentialRow | null {
  const enabled = credentials
    .filter((c) => c.status === "enabled")
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return enabled[0] ?? null;
}

/**
 * Only an INHOUSE-vault-managed secret can be decrypted by verification and
 * execution; an external `secretRef` cannot. This inspects which columns
 * are populated — it never decrypts anything.
 */
function isUsable(credential: VendorCredentialRow): boolean {
  return (
    credential.secret_ciphertext !== null &&
    credential.secret_iv !== null &&
    credential.secret_auth_tag !== null &&
    credential.secret_encryption_version !== null
  );
}

/**
 * Pure, deterministic, read-time derivation of a provider account's
 * operational readiness — nothing is persisted, contacted, or decrypted.
 *
 * Precedence (first match wins):
 *  1. disabled           — vendor or account status is not `enabled`
 *  2. unsupported        — no adapter is registered for the vendor's protocol
 *  3. missing_credential — no enabled credential, or the selected one is not usable
 *  4. unverified         — no health snapshot, or its status is `unknown`
 *  5. unhealthy          — last recorded health is `unhealthy`
 *  6. ready              — otherwise (`healthy`, or `degraded`, which routing
 *                          and execution also still treat as usable)
 */
export function deriveAccountReadiness(input: AccountReadinessInput): AccountReadinessResult {
  const { vendor, account, adapterSupported, health } = input;
  const candidate = selectCandidateCredential(input.credentials);
  const credential = {
    present: input.credentials.length > 0,
    enabled: candidate !== null,
    usable: candidate !== null && isUsable(candidate),
    lastTestedAt: candidate?.last_tested_at ?? null,
    lastSuccessfulAt: candidate?.last_successful_at ?? null,
  };

  let readiness: AccountReadiness;
  let reason: AccountReadinessReason;
  if (vendor.status !== "enabled") {
    readiness = "disabled";
    reason = "vendor_not_enabled";
  } else if (account.status !== "enabled") {
    readiness = "disabled";
    reason = "account_not_enabled";
  } else if (!adapterSupported) {
    readiness = "unsupported";
    reason = "no_adapter_for_protocol";
  } else if (!credential.enabled) {
    readiness = "missing_credential";
    reason = "no_enabled_credential";
  } else if (!credential.usable) {
    readiness = "missing_credential";
    reason = "credential_not_usable";
  } else if (!health || health.status === "unknown") {
    readiness = "unverified";
    reason = "never_verified";
  } else if (health.status === "unhealthy") {
    readiness = "unhealthy";
    reason = "last_check_unhealthy";
  } else {
    readiness = "ready";
    reason = health.status === "degraded" ? "last_check_degraded" : "last_check_healthy";
  }

  return {
    readiness,
    reason,
    vendorId: vendor.id,
    vendorAccountId: account.id,
    vendorStatus: vendor.status,
    accountStatus: account.status,
    adapterSupported,
    credential,
    health: {
      status: health?.status ?? "unknown",
      lastCheckedAt: health?.last_checked_at ?? null,
      lastSuccessAt: health?.last_success_at ?? null,
      lastFailureAt: health?.last_failure_at ?? null,
      consecutiveFailures: health?.consecutive_failures ?? 0,
      lastLatencyMs: health?.last_latency_ms ?? null,
      lastErrorCategory: health?.last_error_category ?? null,
      lastSafeErrorCode: health?.last_safe_error_code ?? null,
    },
  };
}

/**
 * Control-plane read of one account's readiness. Loads existing rows and
 * derives; it never decrypts a credential (no `credentialSecretAccess`),
 * calls a provider or adapter method (only `AdapterRegistry.has()`),
 * records health, writes audit or ledger rows, or takes part in routing or
 * execution.
 */
export class AccountReadinessService {
  private readonly vendors: VendorsRepository;
  private readonly accounts: VendorAccountsRepository;
  private readonly credentials: VendorCredentialsRepository;
  private readonly health: ProviderHealthService;

  constructor(
    pool: Pool,
    private readonly adapters: AdapterRegistry,
  ) {
    this.vendors = new VendorsRepository(pool);
    this.accounts = new VendorAccountsRepository(pool);
    this.credentials = new VendorCredentialsRepository(pool);
    this.health = new ProviderHealthService(pool);
  }

  async getReadiness(vendorId: string, accountId: string): Promise<AccountReadinessResult> {
    const vendor = await this.vendors.findById(vendorId);
    if (!vendor) throw new NotFoundError(`Vendor "${vendorId}" was not found.`);
    const account = await this.accounts.findById(accountId);
    if (!account || account.vendor_id !== vendor.id) {
      throw new NotFoundError(`Account "${accountId}" was not found for vendor "${vendorId}".`);
    }
    const [credentials, health] = await Promise.all([
      this.credentials.listByVendorAccountId(account.id),
      this.health.getCurrentHealth(vendor.id, account.id),
    ]);
    return deriveAccountReadiness({
      vendor,
      account,
      credentials,
      adapterSupported: this.adapters.has(vendor.protocol),
      health,
    });
  }
}
