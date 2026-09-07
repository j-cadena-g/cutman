import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "./ensure.ts";

function statements(sql: string): string[] {
  return sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

describe("SCHEMA_SQL", () => {
  it("matches schema.sql and 0001_init.sql after stripping comments", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const packaged = readFileSync(join(here, "schema.sql"), "utf8");
    const migration = readFileSync(join(here, "../../../apps/web/d1/0001_init.sql"), "utf8");
    expect(statements(SCHEMA_SQL)).toEqual(statements(packaged));
    expect(statements(SCHEMA_SQL)).toEqual(statements(migration));
  });
});
