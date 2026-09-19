import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { DbConfig } from "../types/db.js";

/**
 * Minimal shape shared by `Pool` and `PoolClient` so repositories can accept
 * either — a plain pool connection for reads, or a transaction client when a
 * caller composes multiple writes atomically.
 */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * Creates the Inhouse Postgres pool. The schema is pinned via `search_path`
 * at connection time so every query resolves against the dedicated Inhouse
 * schema/namespace without repositories having to qualify table names.
 */
export function createPool(config: DbConfig): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    min: config.poolMin,
    max: config.poolMax,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    options: `-c search_path=${config.schema},public`,
  });
}

/**
 * Unwraps a single-row result (e.g. from `RETURNING *`). Throws if the
 * query unexpectedly produced no rows, since `noUncheckedIndexedAccess`
 * otherwise leaves callers with a spurious `| undefined`.
 */
export function expectRow<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) {
    throw new Error("Expected a row to be returned, but none was.");
  }
  return row;
}

/**
 * Runs `fn` inside a single BEGIN/COMMIT transaction on a dedicated client,
 * rolling back on any error. Always releases the client back to the pool.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
