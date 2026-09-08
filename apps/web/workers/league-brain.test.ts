/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import {
  activateLeague,
  createLeague,
  ensureSchema,
  listRecapRecipients,
  setRecapOptIn,
  upsertLeagueMember,
  upsertUserByClerkId,
} from "@cutman/db";
import {
  V1_LEAGUE_ID,
  fixtureMatchupsFinal,
  fixtureMatchupsInProgress,
  fixturePlayers,
  fixtureRosters,
  fixtureTransactions,
  fixtureUsersVerified,
  v1FixtureUsers,
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
  await stub.bootstrap({
    leagueId: "lg-group-chat",
    sleeperLeagueId: "sleeper-lg-group-chat",
    name: "The Group Chat",
    tone: "playful",
  });
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
    const result = await runInDurableObject(stub, async (instance) => {
      return (instance as LeagueBrain).attemptRecapWithGenerator(fixtureMatchupsInProgress, [], async () => ({
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
    const first = await runInDurableObject(stub, async (instance) => {
      return (instance as LeagueBrain).attemptRecapWithGenerator(fixtureMatchupsFinal, [], async () => ({
        subject: "Week 3 belongs to Alex",
        body: "CeeDee changed hands and the chat lost its mind.",
      }));
    });
    const second = await runInDurableObject(stub, async (instance) => {
      return (instance as LeagueBrain).attemptRecapWithGenerator(fixtureMatchupsFinal, [], async () => ({
        subject: "Week 3 again",
        body: "Should not publish twice.",
      }));
    });
    expect(first.status).toBe("published");
    expect(second.status).toBe("skipped_already");
    const recaps = await stub.listRecaps();
    expect(recaps).toHaveLength(1);
    expect(recaps[0]?.subject).toBe("Week 3 belongs to Alex");
  });

  it("publishes nothing when the model errors", async () => {
    const stub = await boot("model-error");
    await stub.ingestSnapshot(snapshot(), fixturePlayers);
    const result = await runInDurableObject(stub, async (instance) => {
      return (instance as LeagueBrain).attemptRecapWithGenerator(fixtureMatchupsFinal, [], async () => {
        throw new Error("gemma down");
      });
    });
    expect(result.status).toBe("model_error");
    expect(await stub.listRecaps()).toEqual([]);
  });
});

describe("LeagueBrain internal vs Sleeper identity", () => {
  // Distinct on purpose: a mix-up of these two ids would make poll miss the fixture league
  // (Sleeper calls) or miss D1 recap recipients (internal id).
  const INTERNAL_ID = "internal_brain_lg_1";
  const SLEEPER_ID = V1_LEAGUE_ID;

  async function latestSnapshotPayload(stub: DurableObjectStub<LeagueBrain>): Promise<LeagueSnapshot> {
    return runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec("SELECT payload FROM snapshots ORDER BY id DESC LIMIT 1").toArray()[0] as
        | { payload: string }
        | undefined;
      if (!row) throw new Error("expected a stored snapshot");
      return JSON.parse(row.payload) as LeagueSnapshot;
    });
  }

  it("stores internal and Sleeper ids separately, returns both on the dashboard, and does not duplicate bible on re-bootstrap", async () => {
    const stub = env.LEAGUE_BRAIN.getByName("ids-separate");
    await stub.bootstrap({
      leagueId: INTERNAL_ID,
      sleeperLeagueId: SLEEPER_ID,
      name: "Split Identity League",
      tone: "savage",
    });
    await stub.bootstrap({
      leagueId: INTERNAL_ID,
      sleeperLeagueId: SLEEPER_ID,
      name: "Split Identity League",
      tone: "savage",
    });

    const dashboard = await stub.getDashboard();
    expect(dashboard.leagueId).toBe(INTERNAL_ID);
    expect(dashboard.sleeperLeagueId).toBe(SLEEPER_ID);
    expect(dashboard.leagueId).not.toBe(dashboard.sleeperLeagueId);
    expect(dashboard.name).toBe("Split Identity League");
    expect(dashboard.tone).toBe("savage");
    expect(dashboard.bible).toHaveLength(1);
  });

  it("polls Sleeper with the Sleeper league id, not the internal id", async () => {
    const stub = env.LEAGUE_BRAIN.getByName("poll-sleeper-id");
    await stub.bootstrap({
      leagueId: INTERNAL_ID,
      sleeperLeagueId: SLEEPER_ID,
      name: "Split Identity League",
      tone: "playful",
    });

    await stub.poll();
    const stored = await latestSnapshotPayload(stub);
    // Fixture users only come back when getLeagueUsers is called with V1_LEAGUE_ID. Calling with
    // the internal id yields []. Snapshot identity stays the Cutman league id.
    expect(v1FixtureUsers.length).toBeGreaterThan(0);
    expect(stored.users).toHaveLength(v1FixtureUsers.length);
    expect(stored.leagueId).toBe(INTERNAL_ID);
  });

  it("looks up recap recipients by the internal league id, not the Sleeper id", async () => {
    await ensureSchema(env.DB);
    const now = 1_803_000_000_000;
    const league = await createLeague(env.DB, {
      id: INTERNAL_ID,
      sleeperLeagueId: SLEEPER_ID,
      name: "Split Identity League",
      season: "2026",
      now,
    });
    await activateLeague(env.DB, league.id, now + 1);
    const user = await upsertUserByClerkId(env.DB, {
      id: "user_brain_recap_1",
      email: "brain-recap-1@example.test",
      now,
    });
    await upsertLeagueMember(env.DB, { leagueId: INTERNAL_ID, userId: user.id, role: "member", now });
    await setRecapOptIn(env.DB, INTERNAL_ID, user.id, true);

    expect(await listRecapRecipients(env.DB, INTERNAL_ID)).toEqual([{ email: "brain-recap-1@example.test" }]);
    expect(await listRecapRecipients(env.DB, SLEEPER_ID)).toEqual([]);

    const stub = env.LEAGUE_BRAIN.getByName("recap-internal-id");
    await stub.bootstrap({
      leagueId: INTERNAL_ID,
      sleeperLeagueId: SLEEPER_ID,
      name: "Split Identity League",
      tone: "playful",
    });
    await stub.ingestSnapshot(snapshot(), fixturePlayers);

    const sentTo = await runInDurableObject(stub, async (instance) => {
      const captured: string[] = [];
      const brain = instance as unknown as {
        env: { EMAIL: { send(message: { to: string | string[] }): Promise<unknown> } };
        attemptRecapWithGenerator: LeagueBrain["attemptRecapWithGenerator"];
      };
      const originalEmail = brain.env.EMAIL;
      try {
        brain.env.EMAIL = {
          async send(message) {
            if (typeof message.to === "string") captured.push(message.to);
            else captured.push(...message.to);
            return {};
          },
        };
        await brain.attemptRecapWithGenerator(fixtureMatchupsFinal, [], async () => ({
          subject: "Week 3 recap",
          body: "The chat survived another Sunday.",
        }));
        return captured;
      } finally {
        brain.env.EMAIL = originalEmail;
      }
    });

    expect(sentTo).toEqual(["brain-recap-1@example.test"]);
  });

  it("backfills sleeperLeagueId from a pre-split snowflake leagueId", async () => {
    const stub = env.LEAGUE_BRAIN.getByName("legacy-snowflake-id");
    const dashboard = await runInDurableObject(stub, async (instance) => {
      const brain = instance as unknown as {
        migrate(): void;
        putSetting(key: string, value: string): void;
        getDashboard: LeagueBrain["getDashboard"];
      };
      brain.putSetting("leagueId", "123456789012345678");
      brain.putSetting("name", "Legacy");
      brain.putSetting("tone", "playful");
      brain.migrate();
      return brain.getDashboard();
    });
    expect(dashboard.leagueId).toBe("123456789012345678");
    expect(dashboard.sleeperLeagueId).toBe("123456789012345678");
  });

  it("does not treat a generated internal league id as a Sleeper id", async () => {
    const stub = env.LEAGUE_BRAIN.getByName("internal-id-no-backfill");
    await expect(
      runInDurableObject(stub, async (instance) => {
        const brain = instance as unknown as {
          migrate(): void;
          putSetting(key: string, value: string): void;
          getDashboard: LeagueBrain["getDashboard"];
        };
        brain.putSetting("leagueId", "league_internal_1");
        brain.putSetting("name", "Internal");
        brain.putSetting("tone", "playful");
        brain.migrate();
        return brain.getDashboard();
      }),
    ).rejects.toThrow(/not bootstrapped/i);
  });
});
