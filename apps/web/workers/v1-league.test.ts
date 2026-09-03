/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { activateLeague, createLeague, failLeague, getLeagueBySleeperId, provisionLeague } from "@cutman/db";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureV1LeagueRow, v1LeagueId } from "../app/lib/v1.server.ts";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

// Wraps a D1Database so that the very next `UPDATE ... SET status = 'provisioning'` statement's
// `.run()` first runs `onProvisionAttempt`, then proceeds. This deterministically reproduces the
// real-world race `ensureV1LeagueRow` must survive: another caller fully completing
// "error" -> "provisioning" -> "active" in the gap between this caller reading "error" and this
// caller's own `provisionLeague` compare-and-swap actually executing, so that CAS's
// `WHERE status IN ('provisioning', 'error')` no longer matches and it throws.
function withProvisionRaceInjected(db: D1Database, onProvisionAttempt: () => Promise<void>): D1Database {
  let triggered = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      const prepare = Reflect.get(target, prop, receiver) as D1Database["prepare"];
      return (sql: string) => {
        const stmt = prepare.call(target, sql);
        if (triggered || !sql.includes("SET status = 'provisioning'")) return stmt;
        triggered = true;
        return new Proxy(stmt, {
          get(stmtTarget, stmtProp, stmtReceiver) {
            if (stmtProp !== "bind") return Reflect.get(stmtTarget, stmtProp, stmtReceiver);
            const bind = Reflect.get(stmtTarget, stmtProp, stmtReceiver) as typeof stmt.bind;
            return (...args: unknown[]) => {
              const bound = bind.apply(stmtTarget, args);
              return new Proxy(bound, {
                get(boundTarget, boundProp, boundReceiver) {
                  if (boundProp !== "run") return Reflect.get(boundTarget, boundProp, boundReceiver);
                  const run = Reflect.get(boundTarget, boundProp, boundReceiver) as typeof bound.run;
                  return async () => {
                    await onProvisionAttempt();
                    return run.call(boundTarget);
                  };
                },
              });
            };
          },
        });
      };
    },
  });
}

describe("ensureV1LeagueRow", () => {
  it("resolves two concurrent first loads to the same active league instead of one throwing", async () => {
    const now = Date.now();

    // Neither request has ever run before: there is no league row for the configured Sleeper
    // league id yet. Both requests race through create -> provision -> activate; only one
    // `activateLeague` compare-and-swap can win, so the loser must recover to the now-active
    // row instead of rejecting (which would surface as a 500 to whichever request lost).
    const [first, second] = await Promise.all([ensureV1LeagueRow(env, now), ensureV1LeagueRow(env, now)]);

    expect(first.status).toBe("active");
    expect(second.status).toBe("active");
    expect(first.id).toBe(second.id);
    expect(first.activated_at).not.toBeNull();

    const stored = await getLeagueBySleeperId(env.DB, first.sleeper_league_id);
    expect(stored?.status).toBe("active");
  });

  it("resolves two concurrent recoveries from an error league without either request failing", async () => {
    // A distinct configured league id (via an overridden env) keeps this test's league
    // independent of the "first load" test above, regardless of execution order.
    const testEnv = { ...env, V1_LEAGUE_ID: "9999999999999999999" };
    const sleeperLeagueId = v1LeagueId(testEnv);
    const seedNow = Date.now();

    // Seed a league that already failed a prior provisioning attempt (status "error"), the
    // starting point `ensureV1LeagueRow` re-provisions from. Two concurrent callers can both
    // read this same "error" snapshot and both attempt `provisionLeague`; whichever loses that
    // compare-and-swap — including losing because the other caller has *already* raced all the
    // way to "active" — must recover to the now-active row instead of throwing.
    const seeded = await createLeague(testEnv.DB, {
      id: sleeperLeagueId,
      sleeperLeagueId,
      name: "Recovery League",
      season: "2026",
      now: seedNow,
    });
    await failLeague(testEnv.DB, seeded.id, "boom");

    const [first, second] = await Promise.all([
      ensureV1LeagueRow(testEnv, seedNow + 1),
      ensureV1LeagueRow(testEnv, seedNow + 2),
    ]);

    expect(first.status).toBe("active");
    expect(second.status).toBe("active");
    expect(first.id).toBe(second.id);

    const stored = await getLeagueBySleeperId(testEnv.DB, sleeperLeagueId);
    expect(stored?.status).toBe("active");
  });

  it("recovers when provisionLeague itself loses an error -> active race, not only activateLeague", async () => {
    const testEnv = { ...env, V1_LEAGUE_ID: "7777777777777777777" };
    const sleeperLeagueId = v1LeagueId(testEnv);
    const seedNow = Date.now();
    const seeded = await createLeague(env.DB, {
      id: sleeperLeagueId,
      sleeperLeagueId,
      name: "Recovery League 3",
      season: "2026",
      now: seedNow,
    });
    await failLeague(env.DB, seeded.id, "boom");

    // Force the exact ordering that natural scheduling in this suite never produces on its own
    // (verified empirically: even 8 truly concurrent `ensureV1LeagueRow` calls never hit this
    // branch, because `provisionLeague`'s own CAS tolerates a concurrent "provisioning" retry).
    // Right as this call's `provisionLeague` UPDATE is about to run, a separate "winner" fully
    // completes error -> provisioning -> active on the real database, so the intercepted UPDATE's
    // `WHERE status IN ('provisioning', 'error')` no longer matches and `provisionLeague` throws.
    const racyDb = withProvisionRaceInjected(env.DB, async () => {
      await provisionLeague(env.DB, seeded.id);
      await activateLeague(env.DB, seeded.id, seedNow + 1);
    });

    const result = await ensureV1LeagueRow({ ...testEnv, DB: racyDb }, seedNow + 2);

    expect(result.status).toBe("active");
    expect(result.id).toBe(seeded.id);

    const stored = await getLeagueBySleeperId(env.DB, sleeperLeagueId);
    expect(stored?.status).toBe("active");
  });
});
