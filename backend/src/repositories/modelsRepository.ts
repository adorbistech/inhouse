import { expectRow, type Queryable } from "../db/client.js";
import type { ModelPatch, ModelRow, NewModel } from "./types.js";

const MODEL_PATCH_COLUMNS = [
  "provider_model_id",
  "inhouse_alias",
  "display_name",
  "context_window",
  "status",
] as const satisfies readonly (keyof ModelPatch)[];

export interface ModelListFilters {
  vendorId?: string;
  status?: string;
  capabilityId?: string;
  workloadId?: string;
  search?: string;
  limit: number;
  offset: number;
}

export class ModelsRepository {
  constructor(private readonly db: Queryable) {}

  async create(model: NewModel): Promise<ModelRow> {
    const result = await this.db.query<ModelRow>(
      `INSERT INTO models (vendor_id, provider_model_id, inhouse_alias, display_name, context_window, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [model.vendor_id, model.provider_model_id, model.inhouse_alias, model.display_name, model.context_window, model.status],
    );
    return expectRow(result.rows);
  }

  async findById(id: string): Promise<ModelRow | null> {
    const result = await this.db.query<ModelRow>("SELECT * FROM models WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async findByAlias(inhouseAlias: string): Promise<ModelRow | null> {
    const result = await this.db.query<ModelRow>("SELECT * FROM models WHERE inhouse_alias = $1", [inhouseAlias]);
    return result.rows[0] ?? null;
  }

  async listByVendorId(vendorId: string): Promise<ModelRow[]> {
    const result = await this.db.query<ModelRow>("SELECT * FROM models WHERE vendor_id = $1 ORDER BY created_at", [
      vendorId,
    ]);
    return result.rows;
  }

  /**
   * Data-driven filtering, all parameterized. Every filter is passed as a
   * bound parameter (NULL when unset) rather than conditionally building
   * SQL text, so the query shape never changes with user input.
   */
  async list(filters: ModelListFilters): Promise<ModelRow[]> {
    const result = await this.db.query<ModelRow>(
      `SELECT DISTINCT m.* FROM models m
       LEFT JOIN model_capabilities mc ON mc.model_id = m.id AND $3::uuid IS NOT NULL
       LEFT JOIN model_workloads mw ON mw.model_id = m.id AND $4::uuid IS NOT NULL
       WHERE ($1::uuid IS NULL OR m.vendor_id = $1)
         AND ($2::text IS NULL OR m.status = $2)
         AND ($3::uuid IS NULL OR mc.capability_id = $3)
         AND ($4::uuid IS NULL OR mw.workload_id = $4)
         AND (
           $5::text IS NULL
           OR m.display_name ILIKE '%' || $5 || '%'
           OR m.inhouse_alias ILIKE '%' || $5 || '%'
           OR m.provider_model_id ILIKE '%' || $5 || '%'
         )
       ORDER BY m.created_at
       LIMIT $6 OFFSET $7`,
      [
        filters.vendorId ?? null,
        filters.status ?? null,
        filters.capabilityId ?? null,
        filters.workloadId ?? null,
        filters.search ?? null,
        filters.limit,
        filters.offset,
      ],
    );
    return result.rows;
  }

  async update(id: string, patch: ModelPatch): Promise<ModelRow | null> {
    const columns = MODEL_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
    if (columns.length === 0) {
      return this.findById(id);
    }
    const setClause = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
    const values = columns.map((column) => patch[column]);
    const result = await this.db.query<ModelRow>(
      `UPDATE models SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    return result.rows[0] ?? null;
  }

  async setStatus(id: string, status: string): Promise<ModelRow | null> {
    const result = await this.db.query<ModelRow>("UPDATE models SET status = $2 WHERE id = $1 RETURNING *", [
      id,
      status,
    ]);
    return result.rows[0] ?? null;
  }
}
