import type { Pool } from "pg";
import { withTransaction, type Queryable } from "../db/client.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/httpErrors.js";
import type { CredentialVaultService, EncryptedSecret } from "../lib/credentialVault.js";
import { AuditEventsRepository } from "../repositories/auditEventsRepository.js";
import { CapabilitiesRepository } from "../repositories/capabilitiesRepository.js";
import type {
  CapabilityRow,
  NewVendor,
  NewVendorAccount,
  VendorAccountPatch,
  VendorAccountRow,
  VendorCredentialPatch,
  VendorCredentialRow,
  VendorPatch,
  VendorRow,
  WorkloadRow,
} from "../repositories/types.js";
import { VendorAccountsRepository } from "../repositories/vendorAccountsRepository.js";
import { VendorCredentialsRepository } from "../repositories/vendorCredentialsRepository.js";
import { VendorsRepository } from "../repositories/vendorsRepository.js";
import { WorkloadsRepository } from "../repositories/workloadsRepository.js";
import type { CreateCredentialInput, UpdateCredentialInput } from "../validation/vendors.js";

export interface VendorDetail extends VendorRow {
  accounts: VendorAccountRow[];
  capabilities: CapabilityRow[];
  workloads: WorkloadRow[];
}

export interface AuditContext {
  actorId: string | null;
  requestId: string;
}

interface PgError {
  code?: string;
}

function isUniqueViolation(error: unknown): error is PgError {
  return typeof error === "object" && error !== null && (error as PgError).code === "23505";
}

/**
 * Orchestrates Vendor System reads/writes: validation happens before this
 * layer (route handlers call the `validate*` functions first), this layer
 * owns transactions and audit-event recording, and every actual query goes
 * through the typed repositories below it. No SQL lives here directly.
 */
export class VendorService {
  private readonly vendors: VendorsRepository;
  private readonly accounts: VendorAccountsRepository;
  private readonly credentials: VendorCredentialsRepository;
  private readonly capabilities: CapabilitiesRepository;
  private readonly workloads: WorkloadsRepository;
  private readonly auditEvents: AuditEventsRepository;

  constructor(
    private readonly pool: Pool,
    private readonly vault: CredentialVaultService,
  ) {
    this.vendors = new VendorsRepository(pool);
    this.accounts = new VendorAccountsRepository(pool);
    this.credentials = new VendorCredentialsRepository(pool);
    this.capabilities = new CapabilitiesRepository(pool);
    this.workloads = new WorkloadsRepository(pool);
    this.auditEvents = new AuditEventsRepository(pool);
  }

  private async recordAudit(
    db: Queryable,
    ctx: AuditContext,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await new AuditEventsRepository(db).create({
      actor_id: ctx.actorId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      metadata,
      request_id: ctx.requestId,
    });
  }

  /**
   * Every capability/workload ID a caller supplies must already exist —
   * otherwise `replaceForVendor`'s INSERT hits the FK constraint on
   * `vendor_capabilities`/`vendor_workloads` and Postgres throws a raw
   * foreign-key-violation mid-transaction. Checking first turns that into
   * a clean 400 before any write happens, so a mixed valid+invalid list
   * never partially assigns anything (nothing is touched at all).
   */
  private async assertCapabilitiesExist(capabilityIds: string[]): Promise<void> {
    if (capabilityIds.length === 0) return;
    const found = await this.capabilities.findByIds(capabilityIds);
    const foundIds = new Set(found.map((c) => c.id));
    const missing = capabilityIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ValidationError(`Unknown capability id(s): ${missing.join(", ")}`);
    }
  }

  private async assertWorkloadsExist(workloadIds: string[]): Promise<void> {
    if (workloadIds.length === 0) return;
    const found = await this.workloads.findByIds(workloadIds);
    const foundIds = new Set(found.map((w) => w.id));
    const missing = workloadIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ValidationError(`Unknown workload id(s): ${missing.join(", ")}`);
    }
  }

  private async toDetail(vendor: VendorRow): Promise<VendorDetail> {
    const [accounts, capabilities, workloads] = await Promise.all([
      this.accounts.listByVendorId(vendor.id),
      this.capabilities.listForVendor(vendor.id),
      this.workloads.listForVendor(vendor.id),
    ]);
    return { ...vendor, accounts, capabilities, workloads };
  }

  async list(filters: { status?: string } = {}): Promise<VendorRow[]> {
    return this.vendors.list(filters);
  }

  async getDetail(id: string): Promise<VendorDetail> {
    const vendor = await this.vendors.findById(id);
    if (!vendor) {
      throw new NotFoundError(`Vendor "${id}" was not found.`);
    }
    return this.toDetail(vendor);
  }

  private async getVendorOrThrow(id: string): Promise<VendorRow> {
    const vendor = await this.vendors.findById(id);
    if (!vendor) {
      throw new NotFoundError(`Vendor "${id}" was not found.`);
    }
    return vendor;
  }

  async create(
    input: { vendor: NewVendor; capabilityIds?: string[]; workloadIds?: string[] },
    ctx: AuditContext,
  ): Promise<VendorDetail> {
    await this.assertCapabilitiesExist(input.capabilityIds ?? []);
    await this.assertWorkloadsExist(input.workloadIds ?? []);
    try {
      return await withTransaction(this.pool, async (client) => {
        const vendors = new VendorsRepository(client);
        const created = await vendors.create(input.vendor);

        if (input.capabilityIds && input.capabilityIds.length > 0) {
          await new CapabilitiesRepository(client).replaceForVendor(created.id, input.capabilityIds);
        }
        if (input.workloadIds && input.workloadIds.length > 0) {
          await new WorkloadsRepository(client).replaceForVendor(created.id, input.workloadIds);
        }

        await this.recordAudit(client, ctx, "vendor.created", "vendor", created.id, {
          slug: created.slug,
        });

        const accounts = await new VendorAccountsRepository(client).listByVendorId(created.id);
        const capabilities = await new CapabilitiesRepository(client).listForVendor(created.id);
        const workloads = await new WorkloadsRepository(client).listForVendor(created.id);
        return { ...created, accounts, capabilities, workloads };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A vendor with slug "${input.vendor.slug}" already exists.`);
      }
      throw error;
    }
  }

  async update(id: string, patch: VendorPatch, ctx: AuditContext): Promise<VendorDetail> {
    await this.getVendorOrThrow(id);
    try {
      return await withTransaction(this.pool, async (client) => {
        const updated = await new VendorsRepository(client).update(id, patch);
        if (!updated) {
          throw new NotFoundError(`Vendor "${id}" was not found.`);
        }
        await this.recordAudit(client, ctx, "vendor.updated", "vendor", id, {
          fields: Object.keys(patch),
        });
        return updated;
      }).then((vendor) => this.toDetail(vendor));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A vendor with slug "${String(patch.slug)}" already exists.`);
      }
      throw error;
    }
  }

  async setStatus(id: string, status: string, ctx: AuditContext): Promise<VendorDetail> {
    await this.getVendorOrThrow(id);
    const vendor = await withTransaction(this.pool, async (client) => {
      const updated = await new VendorsRepository(client).setStatus(id, status);
      if (!updated) {
        throw new NotFoundError(`Vendor "${id}" was not found.`);
      }
      await this.recordAudit(client, ctx, `vendor.${status}`, "vendor", id, { status });
      return updated;
    });
    return this.toDetail(vendor);
  }

  async setCapabilities(id: string, capabilityIds: string[], ctx: AuditContext): Promise<CapabilityRow[]> {
    await this.getVendorOrThrow(id);
    await this.assertCapabilitiesExist(capabilityIds);
    return withTransaction(this.pool, async (client) => {
      await new CapabilitiesRepository(client).replaceForVendor(id, capabilityIds);
      await this.recordAudit(client, ctx, "vendor.capabilities_updated", "vendor", id, {
        count: capabilityIds.length,
      });
      return new CapabilitiesRepository(client).listForVendor(id);
    });
  }

  async setWorkloads(id: string, workloadIds: string[], ctx: AuditContext): Promise<WorkloadRow[]> {
    await this.getVendorOrThrow(id);
    await this.assertWorkloadsExist(workloadIds);
    return withTransaction(this.pool, async (client) => {
      await new WorkloadsRepository(client).replaceForVendor(id, workloadIds);
      await this.recordAudit(client, ctx, "vendor.workloads_updated", "vendor", id, {
        count: workloadIds.length,
      });
      return new WorkloadsRepository(client).listForVendor(id);
    });
  }

  // --- Accounts ---

  async listAccounts(vendorId: string): Promise<VendorAccountRow[]> {
    await this.getVendorOrThrow(vendorId);
    return this.accounts.listByVendorId(vendorId);
  }

  async createAccount(
    vendorId: string,
    input: Omit<NewVendorAccount, "vendor_id">,
    ctx: AuditContext,
  ): Promise<VendorAccountRow> {
    await this.getVendorOrThrow(vendorId);
    try {
      return await withTransaction(this.pool, async (client) => {
        const account = await new VendorAccountsRepository(client).create({ ...input, vendor_id: vendorId });
        await this.recordAudit(client, ctx, "vendor_account.created", "vendor_account", account.id, {
          vendorId,
          slug: account.slug,
        });
        return account;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`An account with slug "${input.slug}" already exists for this vendor.`);
      }
      throw error;
    }
  }

  private async getAccountOrThrow(vendorId: string, accountId: string): Promise<VendorAccountRow> {
    const account = await this.accounts.findById(accountId);
    if (!account || account.vendor_id !== vendorId) {
      throw new NotFoundError(`Account "${accountId}" was not found for vendor "${vendorId}".`);
    }
    return account;
  }

  async updateAccount(
    vendorId: string,
    accountId: string,
    patch: VendorAccountPatch,
    ctx: AuditContext,
  ): Promise<VendorAccountRow> {
    await this.getAccountOrThrow(vendorId, accountId);
    try {
      return await withTransaction(this.pool, async (client) => {
        const updated = await new VendorAccountsRepository(client).update(accountId, patch);
        if (!updated) {
          throw new NotFoundError(`Account "${accountId}" was not found.`);
        }
        await this.recordAudit(client, ctx, "vendor_account.updated", "vendor_account", accountId, {
          vendorId,
          fields: Object.keys(patch),
        });
        return updated;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`An account with slug "${String(patch.slug)}" already exists for this vendor.`);
      }
      throw error;
    }
  }

  async setAccountStatus(
    vendorId: string,
    accountId: string,
    status: string,
    ctx: AuditContext,
  ): Promise<VendorAccountRow> {
    await this.getAccountOrThrow(vendorId, accountId);
    return withTransaction(this.pool, async (client) => {
      const updated = await new VendorAccountsRepository(client).setStatus(accountId, status);
      if (!updated) {
        throw new NotFoundError(`Account "${accountId}" was not found.`);
      }
      await this.recordAudit(client, ctx, `vendor_account.${status}`, "vendor_account", accountId, {
        vendorId,
        status,
      });
      return updated;
    });
  }

  // --- Credentials ---

  async listCredentials(vendorId: string): Promise<VendorCredentialRow[]> {
    await this.getVendorOrThrow(vendorId);
    return this.credentials.listByVendorId(vendorId);
  }

  /**
   * Translates the HTTP-facing `secret`/`secretRef` choice into the
   * repository's encrypted-column shape. Encryption happens here — the
   * one seam between "raw secret just arrived over HTTP" and "only
   * ciphertext ever reaches a query parameter or a response". The raw
   * `secret` value is never retained beyond this call's stack frame.
   */
  private encodeSecretMode(
    secretRef: string | null | undefined,
    secret: string | null | undefined,
  ): Pick<
    VendorCredentialRow,
    | "secret_ref"
    | "secret_ciphertext"
    | "secret_iv"
    | "secret_auth_tag"
    | "secret_fingerprint"
    | "secret_masked"
    | "secret_encryption_version"
  > {
    if (secret) {
      const encrypted: EncryptedSecret = this.vault.encrypt(secret);
      return {
        secret_ref: null,
        secret_ciphertext: encrypted.ciphertext,
        secret_iv: encrypted.iv,
        secret_auth_tag: encrypted.authTag,
        secret_fingerprint: encrypted.fingerprint,
        secret_masked: encrypted.maskedIdentifier,
        secret_encryption_version: encrypted.version,
      };
    }
    return {
      secret_ref: secretRef ?? null,
      secret_ciphertext: null,
      secret_iv: null,
      secret_auth_tag: null,
      secret_fingerprint: null,
      secret_masked: null,
      secret_encryption_version: null,
    };
  }

  async createCredential(vendorId: string, input: CreateCredentialInput, ctx: AuditContext): Promise<VendorCredentialRow> {
    await this.getAccountOrThrow(vendorId, input.vendorAccountId);
    return withTransaction(this.pool, async (client) => {
      const credential = await new VendorCredentialsRepository(client).create({
        vendor_account_id: input.vendorAccountId,
        credential_type: input.credential_type,
        status: input.status,
        ...this.encodeSecretMode(input.secret_ref, input.secret),
      });
      await this.recordAudit(client, ctx, "vendor_credential.created", "vendor_credential", credential.id, {
        vendorId,
        vendorAccountId: input.vendorAccountId,
        credentialType: credential.credential_type,
      });
      return credential;
    });
  }

  private async getCredentialOrThrow(vendorId: string, credentialId: string): Promise<VendorCredentialRow> {
    const credential = await this.credentials.findById(credentialId);
    if (!credential) {
      throw new NotFoundError(`Credential "${credentialId}" was not found.`);
    }
    await this.getAccountOrThrow(vendorId, credential.vendor_account_id);
    return credential;
  }

  async updateCredential(
    vendorId: string,
    credentialId: string,
    patch: UpdateCredentialInput,
    ctx: AuditContext,
  ): Promise<VendorCredentialRow> {
    await this.getCredentialOrThrow(vendorId, credentialId);
    const isRotating = patch.secret !== undefined || patch.secret_ref !== undefined;
    const repoPatch: VendorCredentialPatch = {
      ...(patch.credential_type !== undefined ? { credential_type: patch.credential_type } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(isRotating ? this.encodeSecretMode(patch.secret_ref, patch.secret) : {}),
    };
    return withTransaction(this.pool, async (client) => {
      const updated = await new VendorCredentialsRepository(client).update(credentialId, repoPatch);
      if (!updated) {
        throw new NotFoundError(`Credential "${credentialId}" was not found.`);
      }
      const action = patch.status !== undefined ? `vendor_credential.${patch.status}` : isRotating ? "vendor_credential.rotated" : "vendor_credential.updated";
      await this.recordAudit(client, ctx, action, "vendor_credential", credentialId, {
        vendorId,
        fields: Object.keys(patch),
      });
      return updated;
    });
  }

  async deleteCredential(vendorId: string, credentialId: string, ctx: AuditContext): Promise<void> {
    await this.getCredentialOrThrow(vendorId, credentialId);
    await withTransaction(this.pool, async (client) => {
      await new VendorCredentialsRepository(client).delete(credentialId);
      await this.recordAudit(client, ctx, "vendor_credential.deleted", "vendor_credential", credentialId, {
        vendorId,
      });
    });
  }
}
