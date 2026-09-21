import type { Pool } from "pg";
import type { CredentialVaultService } from "../lib/credentialVault.js";
import { ConflictError, NotFoundError } from "../lib/httpErrors.js";
import { AuditEventsRepository } from "../repositories/auditEventsRepository.js";
import { VendorAccountsRepository } from "../repositories/vendorAccountsRepository.js";
import { VendorCredentialsRepository } from "../repositories/vendorCredentialsRepository.js";
import { VendorsRepository } from "../repositories/vendorsRepository.js";
import { validateHealthObservationInput, type HealthObservationInput } from "../validation/providerHealth.js";
import type { AdapterRegistry } from "./adapters/adapterRegistry.js";
import { selectCandidateCredential } from "./accountCredentialSelection.js";
import { getDecryptedCredentialSecret } from "./credentialSecretAccess.js";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "./providerAdapter.js";
import { ProviderHealthService } from "./providerHealthService.js";

export interface VerificationResult {
  vendorId: string;
  vendorAccountId: string;
  protocol: string;
  status: "healthy" | "degraded" | "unhealthy";
  latencyMs: number | null;
  errorCategory: string | null;
  safeErrorCode: string | null;
  message: string;
  checkedAt: Date;
}

export interface VerificationContext {
  actorId: string | null;
  requestId: string;
}

const CREDENTIAL_UNAVAILABLE_CODE = "CREDENTIAL_UNAVAILABLE";

/**
 * Admin-triggered, bounded verification of one configured provider
 * account (Block 14A). Composes the existing pieces and adds no provider
 * knowledge of its own: vendor identity and endpoint come from the
 * database, protocol behavior from the adapter registry, the secret from
 * `credentialSecretAccess.ts` (the one decrypt boundary), and the result
 * is recorded through `ProviderHealthService`.
 *
 * Deliberately NOT execution: no routing, no retry/fallback, no usage
 * ledger, no client-key involvement. Exactly one `checkHealth()` call.
 * Configuration problems are rejected before the credential is touched;
 * a credential that cannot be decrypted never causes a provider request.
 */
export class ProviderVerificationService {
  private readonly vendors: VendorsRepository;
  private readonly accounts: VendorAccountsRepository;
  private readonly credentials: VendorCredentialsRepository;
  private readonly health: ProviderHealthService;

  constructor(
    private readonly pool: Pool,
    private readonly vault: CredentialVaultService,
    private readonly adapters: AdapterRegistry,
  ) {
    this.vendors = new VendorsRepository(pool);
    this.accounts = new VendorAccountsRepository(pool);
    this.credentials = new VendorCredentialsRepository(pool);
    this.health = new ProviderHealthService(pool);
  }

  async verify(vendorId: string, accountId: string, ctx: VerificationContext): Promise<VerificationResult> {
    // 1. Configuration validation — nothing below here touches a secret.
    const vendor = await this.vendors.findById(vendorId);
    if (!vendor) throw new NotFoundError(`Vendor "${vendorId}" was not found.`);
    const account = await this.accounts.findById(accountId);
    if (!account || account.vendor_id !== vendor.id) {
      throw new NotFoundError(`Account "${accountId}" was not found for vendor "${vendorId}".`);
    }
    if (vendor.status !== "enabled") throw new ConflictError("Vendor is not enabled; enable it before verifying.");
    if (account.status !== "enabled") {
      throw new ConflictError("Vendor account is not enabled; enable it before verifying.");
    }
    const adapter = this.adapters.get(vendor.protocol);
    if (!adapter) {
      throw new ConflictError(`No adapter is registered for the vendor's technical protocol "${vendor.protocol}".`);
    }
    // The same deterministic rule readiness and execution use (created_at, then id).
    const credential = selectCandidateCredential(await this.credentials.listByVendorAccountId(account.id));
    if (!credential) throw new ConflictError("This account has no enabled credential to verify.");

    // 2. Credential access, then one bounded adapter health check.
    let observation: HealthObservationInput;
    let message: string;
    let secret: string | null = null;
    try {
      secret = await getDecryptedCredentialSecret(this.pool, this.vault, credential.id);
    } catch {
      // The reason is deliberately not surfaced (or logged): it can name credential internals.
      secret = null;
    }

    if (secret === null) {
      observation = {
        status: "unhealthy",
        latencyMs: null,
        errorCategory: "configuration",
        safeErrorCode: CREDENTIAL_UNAVAILABLE_CODE,
        source: "adapter",
        checkedAt: new Date(),
      };
      message = "The account's credential could not be accessed; the provider was not contacted.";
    } else {
      const timeoutMs = vendor.timeout_ms ?? DEFAULT_PROVIDER_TIMEOUT_MS;
      try {
        const result = await adapter.checkHealth(secret, { baseEndpoint: vendor.base_endpoint, timeoutMs });
        observation = validateHealthObservationInput({ ...result, source: "adapter", checkedAt: new Date() });
      } catch {
        observation = {
          status: "unhealthy",
          latencyMs: null,
          errorCategory: "unknown",
          safeErrorCode: null,
          source: "adapter",
          checkedAt: new Date(),
        };
      }
      secret = null;
      message =
        observation.status === "healthy"
          ? "The provider account responded successfully."
          : `Verification failed (${observation.errorCategory ?? "unknown"}).`;
    }

    // 3. Record through the existing health service, then a safe audit event.
    const recorded = await this.health.recordObservation(vendor.id, account.id, observation);
    // Every attempt against the selected credential stamps `last_tested_at`; only a healthy result
    // stamps `last_successful_at` (markTested, Block 06 — previously unwired).
    await this.credentials.markTested(credential.id, observation.status === "healthy");
    await new AuditEventsRepository(this.pool).create({
      actor_id: ctx.actorId,
      action: "vendor_account.verified",
      resource_type: "vendor_account",
      resource_id: account.id,
      metadata: {
        vendorId: vendor.id,
        vendorAccountId: account.id,
        protocol: vendor.protocol,
        status: observation.status,
        errorCategory: observation.errorCategory,
        safeErrorCode: observation.safeErrorCode,
        latencyMs: observation.latencyMs,
        requestId: ctx.requestId,
      },
      request_id: ctx.requestId,
    });

    return {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      protocol: vendor.protocol,
      status: observation.status,
      latencyMs: observation.latencyMs,
      errorCategory: observation.errorCategory,
      safeErrorCode: observation.safeErrorCode,
      message,
      checkedAt: recorded.last_checked_at ?? observation.checkedAt,
    };
  }
}
