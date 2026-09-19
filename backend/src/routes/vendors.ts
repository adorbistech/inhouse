import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import type { CredentialVaultService } from "../lib/credentialVault.js";
import type { VendorCredentialRow } from "../repositories/types.js";
import { VendorService } from "../services/vendorService.js";
import {
  validateAccountPatchInput,
  validateCreateAccountInput,
  validateCreateCredentialInput,
  validateCreateVendorInput,
  validateCredentialPatchInput,
  validateIdSetBody,
  validateVendorPatchInput,
  requireUuidParam,
} from "../validation/vendors.js";
import {
  toAccountResponse,
  toCapabilityResponse,
  toVendorDetailResponse,
  toVendorResponse,
  toWorkloadResponse,
} from "./serializers.js";

/**
 * Never returns raw secret material — only safe credential metadata. This
 * is the one explicit projection point that keeps everything in
 * `VendorCredentialRow` (including `secret_ciphertext`/`secret_iv`/
 * `secret_auth_tag`/`secret_fingerprint` — see repositories/types.ts) out
 * of any accidental future leak: only the fields listed here ever leave
 * the API. `secretRef` is the unchanged Block 06 external reference;
 * `maskedSecret`/`hasManagedSecret` describe an INHOUSE-vault-managed
 * secret (Block 08) without ever exposing it.
 */
function toCredentialResponse(credential: VendorCredentialRow) {
  return {
    id: credential.id,
    vendorAccountId: credential.vendor_account_id,
    credentialType: credential.credential_type,
    status: credential.status,
    secretRef: credential.secret_ref,
    hasManagedSecret: credential.secret_ciphertext !== null,
    maskedSecret: credential.secret_masked,
    createdAt: credential.created_at,
    updatedAt: credential.updated_at,
    lastTestedAt: credential.last_tested_at,
    lastSuccessfulAt: credential.last_successful_at,
  };
}

function auditContext(request: FastifyRequest) {
  // No Inhouse authentication exists yet (see docs/API.md) — actorId will
  // be populated once a later block adds real principals.
  return { actorId: null, requestId: request.id };
}

export function registerVendorRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  credentialVault: CredentialVaultService,
): void {
  const service = new VendorService(pool, credentialVault);

  app.register(
    async (versioned) => {
      versioned.get("/vendors", async (request) => {
        const query = request.query as { status?: string };
        const vendors = await service.list({ status: query.status });
        return { vendors: vendors.map(toVendorResponse) };
      });

      versioned.get("/vendors/:id", async (request) => {
        const { id } = request.params as { id: string };
        const vendor = await service.getDetail(requireUuidParam(id, "id"));
        return { vendor: toVendorDetailResponse(vendor) };
      });

      versioned.post("/vendors", async (request, reply) => {
        const input = validateCreateVendorInput(request.body);
        const vendor = await service.create(input, auditContext(request));
        reply.code(201);
        return { vendor: toVendorDetailResponse(vendor) };
      });

      versioned.patch("/vendors/:id", async (request) => {
        const { id } = request.params as { id: string };
        const patch = validateVendorPatchInput(request.body);
        const vendor = await service.update(requireUuidParam(id, "id"), patch, auditContext(request));
        return { vendor: toVendorDetailResponse(vendor) };
      });

      versioned.delete("/vendors/:id", async (request) => {
        const { id } = request.params as { id: string };
        const vendor = await service.setStatus(requireUuidParam(id, "id"), "disabled", auditContext(request));
        return { vendor: toVendorDetailResponse(vendor) };
      });

      versioned.put("/vendors/:id/capabilities", async (request) => {
        const { id } = request.params as { id: string };
        const capabilityIds = validateIdSetBody(request.body, "capabilityIds");
        const capabilities = await service.setCapabilities(
          requireUuidParam(id, "id"),
          capabilityIds,
          auditContext(request),
        );
        return { capabilities: capabilities.map(toCapabilityResponse) };
      });

      versioned.put("/vendors/:id/workloads", async (request) => {
        const { id } = request.params as { id: string };
        const workloadIds = validateIdSetBody(request.body, "workloadIds");
        const workloads = await service.setWorkloads(
          requireUuidParam(id, "id"),
          workloadIds,
          auditContext(request),
        );
        return { workloads: workloads.map(toWorkloadResponse) };
      });

      // --- Vendor accounts ---

      versioned.get("/vendors/:id/accounts", async (request) => {
        const { id } = request.params as { id: string };
        const accounts = await service.listAccounts(requireUuidParam(id, "id"));
        return { accounts: accounts.map(toAccountResponse) };
      });

      versioned.post("/vendors/:id/accounts", async (request, reply) => {
        const { id } = request.params as { id: string };
        const input = validateCreateAccountInput(request.body);
        const account = await service.createAccount(requireUuidParam(id, "id"), input, auditContext(request));
        reply.code(201);
        return { account: toAccountResponse(account) };
      });

      versioned.patch("/vendors/:id/accounts/:accountId", async (request) => {
        const { id, accountId } = request.params as { id: string; accountId: string };
        const patch = validateAccountPatchInput(request.body);
        const account = await service.updateAccount(
          requireUuidParam(id, "id"),
          requireUuidParam(accountId, "accountId"),
          patch,
          auditContext(request),
        );
        return { account: toAccountResponse(account) };
      });

      versioned.delete("/vendors/:id/accounts/:accountId", async (request) => {
        const { id, accountId } = request.params as { id: string; accountId: string };
        const account = await service.setAccountStatus(
          requireUuidParam(id, "id"),
          requireUuidParam(accountId, "accountId"),
          "disabled",
          auditContext(request),
        );
        return { account: toAccountResponse(account) };
      });

      // --- Vendor credentials (metadata only — never raw secrets) ---

      versioned.get("/vendors/:id/credentials", async (request) => {
        const { id } = request.params as { id: string };
        const credentials = await service.listCredentials(requireUuidParam(id, "id"));
        return { credentials: credentials.map(toCredentialResponse) };
      });

      versioned.post("/vendors/:id/credentials", async (request, reply) => {
        const { id } = request.params as { id: string };
        const input = validateCreateCredentialInput(request.body);
        const credential = await service.createCredential(requireUuidParam(id, "id"), input, auditContext(request));
        reply.code(201);
        return { credential: toCredentialResponse(credential) };
      });

      versioned.patch("/vendors/:id/credentials/:credentialId", async (request) => {
        const { id, credentialId } = request.params as { id: string; credentialId: string };
        const patch = validateCredentialPatchInput(request.body);
        const credential = await service.updateCredential(
          requireUuidParam(id, "id"),
          requireUuidParam(credentialId, "credentialId"),
          patch,
          auditContext(request),
        );
        return { credential: toCredentialResponse(credential) };
      });

      versioned.delete("/vendors/:id/credentials/:credentialId", async (request, reply) => {
        const { id, credentialId } = request.params as { id: string; credentialId: string };
        await service.deleteCredential(
          requireUuidParam(id, "id"),
          requireUuidParam(credentialId, "credentialId"),
          auditContext(request),
        );
        reply.code(204);
      });
    },
    { prefix: config.apiPrefix },
  );
}
