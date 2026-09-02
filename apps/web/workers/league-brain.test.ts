/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import {
  fixtureMatchupsFinal,
  fixtureMatchupsInProgress,
  fixturePlayers,
  fixtureRosters,
  fixtureTransactions,
  fixtureUsersVerified,
} from "@cutman/sleeper";
import type { LeagueSnapshot } from "@cutman/story";
import { beforeAll, describe, expect, it } from "vitest";
import { LeagueBrain } from "./league-brain.ts";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

function snapshot(matchups = fixtureMatchupsFinal): LeagueSnapshot {
  return {
    leagueId: "lg-group-chat",
    week: 3,
    users: fixtureUsersVerified,
    rosters: fixtureRosters,
    matchups,
    transactions: fixtureTransactions,
  };
}

async function boot(name: string): Promise<DurableObjectStub<LeagueBrain>> {
  const stub = env.LEAGUE_BRAIN.getByName(name);
  await stub.bootstrap({ leagueId: "lg-group-chat", name: "The Group Chat", tone: "playful" });
  return stub;
}

describe("LeagueBrain Durable Object", () => {
  it("does not write a beat when the same snapshot arrives twice", async () => {
    const stub = await boot("idempotent");
    const first = await stub.ingestSnapshot(snapshot(), fixturePlayers);
    const second = await stub.ingestSnapshot(snapshot(), fixturePlayers);
    expect(first.hash).toBe(second.hash);
    expect(second.wroteBeat).toBe(false);
    expect(second.facts).toBe(0);
  });

  it("skips Tuesday recap when the week is not final", async () => {
    const stub = await boot("not-final");
    await stub.ingestSnapshot(snapshot(fixtureMatchupsInProgress), fixturePlayers);
    const result = await runInDurableObject(stub, async (instance: LeagueBrain) => {
      return instance.attemptRecapWithGenerator(fixtureMatchupsInProgress, [], async () => ({
        subject: "should not send",
        body: "nope",
      }));
    });
    expect(result.status).toBe("skipped_not_final");
    expect(await stub.listRecaps()).toEqual([]);
  });

  it("archives a single recap on double-run", async () => {
    const stub = await boot("once");
    await stub.ingestSnapshot(snapshot(), fixturePlayers);
    const first = await runInDurableObject(stub, async (instance: LeagueBrain) => {
      return instance.attemptRecapWithGenerator(fixtureMatchupsFinal, [], async () => ({
        subject: "Week 3 belongs to James",
        body: "CeeDee changed hands and the chat lost its mind.",
      }));
    });
    const second = await runInDurableObject(stub, async (instance: LeagueBrain) => {
      return instance.attemptRecapWithGenerator(fixtureMatchupsFinal, [], async () => ({
        subject: "Week 3 again",
        body: "Should not publish twice.",
      }));
    });
    expect(first.status).toBe("published");
    expect(second.status).toBe("skipped_already");
    const recaps = await stub.listRecaps();
    expect(recaps).toHaveLength(1);
    expect(recaps[0]?.subject).toBe("Week 3 belongs to James");
  });

  it("publishes nothing when the model errors", async () => {
    const stub = await boot("model-error");
    await stub.ingestSnapshot(snapshot(), fixturePlayers);
    const result = await runInDurableObject(stub, async (instance: LeagueBrain) => {
      return instance.attemptRecapWithGenerator(fixtureMatchupsFinal, [], async () => {
        throw new Error("gemma down");
      });
    });
    expect(result.status).toBe("model_error");
    expect(await stub.listRecaps()).toEqual([]);
  });
});
