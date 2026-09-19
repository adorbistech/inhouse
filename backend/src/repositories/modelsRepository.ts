import { expectRow, type Queryable } from "../db/client.js";
import type { ModelRow, NewModel } from "./types.js";

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
}
