import type { Pool } from "pg";
import { withTransaction, type Queryable } from "../db/client.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/httpErrors.js";
import { AuditEventsRepository } from "../repositories/auditEventsRepository.js";
import { CapabilitiesRepository } from "../repositories/capabilitiesRepository.js";
import { ModelsRepository, type ModelListFilters } from "../repositories/modelsRepository.js";
import type { CapabilityRow, ModelPatch, ModelRow, NewModel, WorkloadRow } from "../repositories/types.js";
import { VendorsRepository } from "../repositories/vendorsRepository.js";
import { WorkloadsRepository } from "../repositories/workloadsRepository.js";
import type { AuditContext } from "./vendorService.js";

export interface ModelDetail extends ModelRow {
  capabilities: CapabilityRow[];
  workloads: WorkloadRow[];
}

interface PgError {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(error: unknown): error is PgError {
  return typeof error === "object" && error !== null && (error as PgError).code === "23505";
}

/**
 * Orchestrates Model Catalog reads/writes: validation happens before this
 * layer, this layer owns transactions/audit events, every query goes
 * through a typed repository. Mirrors VendorService's architecture
 * (including the capability/workload existence guard fixed in Block 06).
 */
export class ModelService {
  private readonly models: ModelsRepository;
  private readonly vendors: VendorsRepository;
  private readonly capabilities: CapabilitiesRepository;
  private readonly workloads: WorkloadsRepository;

  constructor(private readonly pool: Pool) {
    this.models = new ModelsRepository(pool);
    this.vendors = new VendorsRepository(pool);
    this.capabilities = new CapabilitiesRepository(pool);
    this.workloads = new WorkloadsRepository(pool);
  }

  private async recordAudit(
    db: Queryable,
    ctx: AuditContext,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await new AuditEventsRepository(db).create({
      actor_id: ctx.actorId,
      action,
      resource_type: "model",
      resource_id: resourceId,
      metadata,
      request_id: ctx.requestId,
    });
  }

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

  private async assertVendorExists(vendorId: string): Promise<void> {
    const vendor = await this.vendors.findById(vendorId);
    if (!vendor) {
      throw new ValidationError(`Unknown vendor id: ${vendorId}`);
    }
  }

  private async toDetail(model: ModelRow): Promise<ModelDetail> {
    const [capabilities, workloads] = await Promise.all([
      this.capabilities.listForModel(model.id),
      this.workloads.listForModel(model.id),
    ]);
    return { ...model, capabilities, workloads };
  }

  async list(filters: ModelListFilters): Promise<ModelRow[]> {
    return this.models.list(filters);
  }

  async getDetail(id: string): Promise<ModelDetail> {
    const model = await this.models.findById(id);
    if (!model) {
      throw new NotFoundError(`Model "${id}" was not found.`);
    }
    return this.toDetail(model);
  }

  private async getModelOrThrow(id: string): Promise<ModelRow> {
    const model = await this.models.findById(id);
    if (!model) {
      throw new NotFoundError(`Model "${id}" was not found.`);
    }
    return model;
  }

  async create(
    input: {
      vendorId: string;
      model: Omit<NewModel, "vendor_id">;
      capabilityIds?: string[];
      workloadIds?: string[];
    },
    ctx: AuditContext,
  ): Promise<ModelDetail> {
    await this.assertVendorExists(input.vendorId);
    await this.assertCapabilitiesExist(input.capabilityIds ?? []);
    await this.assertWorkloadsExist(input.workloadIds ?? []);

    try {
      return await withTransaction(this.pool, async (client) => {
        const models = new ModelsRepository(client);
        const created = await models.create({ ...input.model, vendor_id: input.vendorId });

        if (input.capabilityIds && input.capabilityIds.length > 0) {
          await new CapabilitiesRepository(client).replaceForModel(created.id, input.capabilityIds);
        }
        if (input.workloadIds && input.workloadIds.length > 0) {
          await new WorkloadsRepository(client).replaceForModel(created.id, input.workloadIds);
        }

        await this.recordAudit(client, ctx, "model.created", created.id, {
          vendorId: input.vendorId,
          inhouseAlias: created.inhouse_alias,
        });

        const capabilities = await new CapabilitiesRepository(client).listForModel(created.id);
        const workloads = await new WorkloadsRepository(client).listForModel(created.id);
        return { ...created, capabilities, workloads };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (error.constraint === "models_inhouse_alias_key") {
          throw new ConflictError(`A model with alias "${input.model.inhouse_alias}" already exists.`);
        }
        throw new ConflictError(
          `A model with provider model id "${input.model.provider_model_id}" already exists for this vendor.`,
        );
      }
      throw error;
    }
  }

  async update(id: string, patch: ModelPatch, ctx: AuditContext): Promise<ModelDetail> {
    await this.getModelOrThrow(id);
    try {
      const updated = await withTransaction(this.pool, async (client) => {
        const result = await new ModelsRepository(client).update(id, patch);
        if (!result) {
          throw new NotFoundError(`Model "${id}" was not found.`);
        }
        await this.recordAudit(client, ctx, "model.updated", id, { fields: Object.keys(patch) });
        return result;
      });
      return this.toDetail(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (error.constraint === "models_inhouse_alias_key") {
          throw new ConflictError(`A model with alias "${String(patch.inhouse_alias)}" already exists.`);
        }
        throw new ConflictError(`A model with that provider model id already exists for this vendor.`);
      }
      throw error;
    }
  }

  async setStatus(id: string, status: string, ctx: AuditContext): Promise<ModelDetail> {
    await this.getModelOrThrow(id);
    const model = await withTransaction(this.pool, async (client) => {
      const updated = await new ModelsRepository(client).setStatus(id, status);
      if (!updated) {
        throw new NotFoundError(`Model "${id}" was not found.`);
      }
      await this.recordAudit(client, ctx, `model.${status}`, id, { status });
      return updated;
    });
    return this.toDetail(model);
  }

  async setCapabilities(id: string, capabilityIds: string[], ctx: AuditContext): Promise<CapabilityRow[]> {
    await this.getModelOrThrow(id);
    await this.assertCapabilitiesExist(capabilityIds);
    return withTransaction(this.pool, async (client) => {
      await new CapabilitiesRepository(client).replaceForModel(id, capabilityIds);
      await this.recordAudit(client, ctx, "model.capabilities_updated", id, { count: capabilityIds.length });
      return new CapabilitiesRepository(client).listForModel(id);
    });
  }

  async setWorkloads(id: string, workloadIds: string[], ctx: AuditContext): Promise<WorkloadRow[]> {
    await this.getModelOrThrow(id);
    await this.assertWorkloadsExist(workloadIds);
    return withTransaction(this.pool, async (client) => {
      await new WorkloadsRepository(client).replaceForModel(id, workloadIds);
      await this.recordAudit(client, ctx, "model.workloads_updated", id, { count: workloadIds.length });
      return new WorkloadsRepository(client).listForModel(id);
    });
  }
}
