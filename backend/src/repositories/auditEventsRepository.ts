import { expectRow, type Queryable } from "../db/client.js";
import type { AuditEventRow, NewAuditEvent } from "./types.js";

export class AuditEventsRepository {
  constructor(private readonly db: Queryable) {}

  async create(event: NewAuditEvent): Promise<AuditEventRow> {
    const result = await this.db.query<AuditEventRow>(
      `INSERT INTO audit_events (actor_id, action, resource_type, resource_id, metadata, request_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [event.actor_id, event.action, event.resource_type, event.resource_id, event.metadata, event.request_id],
    );
    return expectRow(result.rows);
  }

  async listRecent(limit = 100): Promise<AuditEventRow[]> {
    const result = await this.db.query<AuditEventRow>(
      "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return result.rows;
  }

  async listForResource(resourceType: string, resourceId: string): Promise<AuditEventRow[]> {
    const result = await this.db.query<AuditEventRow>(
      "SELECT * FROM audit_events WHERE resource_type = $1 AND resource_id = $2 ORDER BY created_at DESC",
      [resourceType, resourceId],
    );
    return result.rows;
  }
}
