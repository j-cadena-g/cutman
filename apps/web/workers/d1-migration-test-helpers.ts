/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";

export type D1Migration = { name: string; queries: string[] };

export function allMigrations(): D1Migration[] {
  return (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
}

export function migrationNamed(fragment: string): D1Migration[] {
  const found = allMigrations().filter((migration) => migration.name.includes(fragment));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one migration matching ${fragment}, got ${found.map((m) => m.name).join(",") || "(none)"}`,
    );
  }
  return found;
}

export async function userTables(): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '_cf_%'
       AND name != 'd1_migrations'
     ORDER BY name`,
  ).all<{ name: string }>();
  return result.results.map((row) => row.name);
}
