import { expectRow, type Queryable } from "../db/client.js";
import type { CapabilityRow, NewCapability } from "./types.js";

export class CapabilitiesRepository {
  constructor(private readonly db: Queryable) {}

  async create(capability: NewCapability): Promise<CapabilityRow> {
    const result = await this.db.query<CapabilityRow>(
      `INSERT INTO capabilities (slug, display_name, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [capability.slug, capability.display_name, capability.description],
    );
    return expectRow(result.rows);
  }

  async findById(id: string): Promise<CapabilityRow | null> {
    const result = await this.db.query<CapabilityRow>("SELECT * FROM capabilities WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async list(): Promise<CapabilityRow[]> {
    const result = await this.db.query<CapabilityRow>("SELECT * FROM capabilities ORDER BY created_at");
    return result.rows;
  }

  async attachToModel(modelId: string, capabilityId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO model_capabilities (model_id, capability_id)
       VALUES ($1, $2)
       ON CONFLICT (model_id, capability_id) DO NOTHING`,
      [modelId, capabilityId],
    );
  }

  async listForModel(modelId: string): Promise<CapabilityRow[]> {
    const result = await this.db.query<CapabilityRow>(
      `SELECT c.* FROM capabilities c
       JOIN model_capabilities mc ON mc.capability_id = c.id
       WHERE mc.model_id = $1
       ORDER BY c.slug`,
      [modelId],
    );
    return result.rows;
  }

  async findByIds(ids: string[]): Promise<CapabilityRow[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query<CapabilityRow>("SELECT * FROM capabilities WHERE id = ANY($1::uuid[])", [
      ids,
    ]);
    return result.rows;
  }

  async listForVendor(vendorId: string): Promise<CapabilityRow[]> {
    const result = await this.db.query<CapabilityRow>(
      `SELECT c.* FROM capabilities c
       JOIN vendor_capabilities vc ON vc.capability_id = c.id
       WHERE vc.vendor_id = $1
       ORDER BY c.slug`,
      [vendorId],
    );
    return result.rows;
  }

  /** Replaces the full set of capabilities assigned to a vendor, atomically. */
  async replaceForVendor(vendorId: string, capabilityIds: string[]): Promise<void> {
    await this.db.query("DELETE FROM vendor_capabilities WHERE vendor_id = $1", [vendorId]);
    for (const capabilityId of capabilityIds) {
      await this.db.query(
        `INSERT INTO vendor_capabilities (vendor_id, capability_id)
         VALUES ($1, $2)
         ON CONFLICT (vendor_id, capability_id) DO NOTHING`,
        [vendorId, capabilityId],
      );
    }
  }

  /** Replaces the full set of capabilities assigned to a model, atomically. */
  async replaceForModel(modelId: string, capabilityIds: string[]): Promise<void> {
    await this.db.query("DELETE FROM model_capabilities WHERE model_id = $1", [modelId]);
    for (const capabilityId of capabilityIds) {
      await this.db.query(
        `INSERT INTO model_capabilities (model_id, capability_id)
         VALUES ($1, $2)
         ON CONFLICT (model_id, capability_id) DO NOTHING`,
        [modelId, capabilityId],
      );
    }
  }
}
