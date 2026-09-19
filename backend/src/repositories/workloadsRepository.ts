import { expectRow, type Queryable } from "../db/client.js";
import type { NewWorkload, WorkloadRow } from "./types.js";

export class WorkloadsRepository {
  constructor(private readonly db: Queryable) {}

  async create(workload: NewWorkload): Promise<WorkloadRow> {
    const result = await this.db.query<WorkloadRow>(
      `INSERT INTO workloads (slug, display_name, description, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [workload.slug, workload.display_name, workload.description, workload.status],
    );
    return expectRow(result.rows);
  }

  async findById(id: string): Promise<WorkloadRow | null> {
    const result = await this.db.query<WorkloadRow>("SELECT * FROM workloads WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async list(): Promise<WorkloadRow[]> {
    const result = await this.db.query<WorkloadRow>("SELECT * FROM workloads ORDER BY created_at");
    return result.rows;
  }

  async attachToModel(modelId: string, workloadId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO model_workloads (model_id, workload_id)
       VALUES ($1, $2)
       ON CONFLICT (model_id, workload_id) DO NOTHING`,
      [modelId, workloadId],
    );
  }

  async listForModel(modelId: string): Promise<WorkloadRow[]> {
    const result = await this.db.query<WorkloadRow>(
      `SELECT w.* FROM workloads w
       JOIN model_workloads mw ON mw.workload_id = w.id
       WHERE mw.model_id = $1
       ORDER BY w.slug`,
      [modelId],
    );
    return result.rows;
  }
}
