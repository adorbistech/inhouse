import { execFileSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/**
 * Manages a disposable, Inhouse-only PostgreSQL container for the
 * DB-backed test suite (`npm run test:db`). It is never the host's
 * PostgreSQL, never `adorbis-core-test-postgres`, and never any other
 * existing service — a fresh container, a fresh named-off host port
 * (Docker-assigned, not fixed), and full teardown afterward.
 */

const CONTAINER_NAME = "inhouse-postgres-test";
const DB_NAME = "inhouse_test";
const DB_USER = "inhouse_test";
const DB_PASSWORD = "inhouse-test-only-not-a-real-secret";
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".test-db.json");

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function removeExistingContainer(): void {
  try {
    docker(["rm", "-f", CONTAINER_NAME]);
  } catch {
    // No leftover container from a previous run — nothing to remove.
  }
}

/** Step 2: waits for Postgres to report ready inside the container. */
async function waitForContainerHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      docker(["exec", CONTAINER_NAME, "pg_isready", "-U", DB_USER, "-d", DB_NAME]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timed out waiting for ${CONTAINER_NAME} to report ready (pg_isready) after ${timeoutMs}ms.`);
}

/**
 * Steps 4–5: closes the cold-start race between "container reports ready"
 * and "the Docker-assigned host port is actually routable" by attempting a
 * real TCP connection *from the host* and authenticating with the test
 * credentials — not just asking the container about itself. Bounded retry;
 * never logs the password (only host:port and elapsed attempts).
 */
async function waitForHostConnectivity(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const client = new Client({
      host: "127.0.0.1",
      port,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
      connectionTimeoutMillis: 2000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for a host-side TCP connection to 127.0.0.1:${port} ` +
      `to succeed and authenticate as "${DB_USER}"/"${DB_NAME}". Last error: ${reason}`,
  );
}

async function start(): Promise<void> {
  removeExistingContainer();

  docker([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-e",
    `POSTGRES_DB=${DB_NAME}`,
    "-e",
    `POSTGRES_USER=${DB_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${DB_PASSWORD}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);

  await waitForContainerHealth();

  const portMapping = docker(["port", CONTAINER_NAME, "5432/tcp"]);
  const port = Number(portMapping.split(":").pop());
  if (!Number.isInteger(port)) {
    throw new Error(`Could not determine the published port for ${CONTAINER_NAME}: "${portMapping}"`);
  }

  await waitForHostConnectivity(port);

  await writeFile(
    STATE_FILE,
    JSON.stringify(
      {
        host: "127.0.0.1",
        port,
        database: DB_NAME,
        user: DB_USER,
        password: DB_PASSWORD,
        schema: "inhouse",
        poolMin: 1,
        poolMax: 5,
        ssl: false,
      },
      null,
      2,
    ),
  );

  console.log(`${CONTAINER_NAME} ready on 127.0.0.1:${port}`);
}

async function stop(): Promise<void> {
  removeExistingContainer();
  await rm(STATE_FILE, { force: true });
  console.log(`${CONTAINER_NAME} removed.`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "start") {
    await start();
  } else if (command === "stop") {
    await stop();
  } else {
    throw new Error(`Unknown command "${command}". Expected "start" or "stop".`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
