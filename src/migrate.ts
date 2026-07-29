import "dotenv/config";

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const MIGRATION_LOCK_NAME = "pull-pool-keeper:migrations";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    throw new Error("DATABASE_URL is required");
  }
  const migrationsDirectory =
    process.env.MIGRATIONS_PATH ||
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../migrations",
    );
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (migrationFiles.length === 0) {
    throw new Error("no ordered SQL migrations were found");
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 60_000,
  });
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1))",
      [MIGRATION_LOCK_NAME],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const name of migrationFiles) {
      const source = await readFile(
        resolve(migrationsDirectory, name),
        "utf8",
      );
      const checksum = createHash("sha256")
        .update(source)
        .digest("hex");
      const existing = await client.query<{
        readonly checksum: string;
      }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name],
      );
      const applied = existing.rows[0];
      if (applied !== undefined) {
        if (applied.checksum !== checksum) {
          throw new Error(
            `applied migration ${name} has changed`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(source);
        await client.query(
          `
            INSERT INTO schema_migrations (name, checksum)
            VALUES ($1, $2)
          `,
          [name, checksum],
        );
        await client.query("COMMIT");
        console.log(`applied migration ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext($1))",
        [MIGRATION_LOCK_NAME],
      );
    } finally {
      client.release();
      await pool.end();
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
