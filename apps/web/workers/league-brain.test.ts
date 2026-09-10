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
import {
  LeagueBrain,
  LEGACY_IMPORT_MAX_ATTEMPTS,
  LEGACY_IMPORT_PENDING_MESSAGE,
  UNBOOTSTRAPPED_MESSAGE,
  type LegacyBrainState,
} from "./league-brain.ts";

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
    const message = await runInDurableObject(stub, async (instance) => {
      const brain = instance as unknown as {
        migrate(): void;
        putSetting(key: string, value: string): void;
        getDashboard: LeagueBrain["getDashboard"];
      };
      brain.putSetting("leagueId", "league_internal_1");
      brain.putSetting("name", "Internal");
      brain.putSetting("tone", "playful");
      brain.migrate();
      try {
        await brain.getDashboard();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(message).toBe(UNBOOTSTRAPPED_MESSAGE);
  });
});

describe("LeagueBrain legacy Durable Object migration", () => {
  // 0002 maps migrated D1 leagues.id to `legacy_${sleeper_league_id}`. Destination
  // brains in these tests use that production-realistic mapping, not a UUID.
  const LEGACY_SLEEPER_ID = "900000000000000001";
  const INTERNAL_ID = `legacy_${LEGACY_SLEEPER_ID}`;
  const MISMATCH_SLEEPER_NAME = "900000000000000011";
  const MISMATCH_INTERNAL_ID = `legacy_${MISMATCH_SLEEPER_NAME}`;
  const OTHER_SLEEPER_ID = "900000000000000002";
  const EMPTY_SLEEPER_ID = "900000000000000003";
  const EMPTY_INTERNAL_ID = `legacy_${EMPTY_SLEEPER_ID}`;
  const NEW_UUID_INTERNAL_ID = "550e8400-e29b-41d4-a716-446655440000";
  const WRONG_CALLER_INTERNAL_ID = "legacy_900000000000000099";
  const SNAPSHOT_CREATED_AT = 1_700_000_000_001;
  const BEAT_CREATED_AT = 1_700_000_000_002;
  const BIBLE_CREATED_AT = 1_700_000_000_003;
  const RECAP_CREATED_AT = 1_700_000_000_004;
  const RECAP_EMAILED_AT = 1_700_000_000_099;
  const LEGACY_FACTS = JSON.stringify([
    { kind: "trade", copy: "CeeDee changed hands", transactionId: "txn_legacy_1" },
  ]);
  const LEGACY_SNAPSHOT = {
    leagueId: LEGACY_SLEEPER_ID,
    week: 3,
    users: fixtureUsersVerified,
    rosters: fixtureRosters,
    matchups: fixtureMatchupsFinal,
    transactions: fixtureTransactions,
  };

  type BrainSql = {
    snapshots: Array<{
      id: number;
      week: number;
      payload_hash: string;
      payload: string;
      created_at: number;
    }>;
    beats: Array<{
      id: number;
      kind: string;
      copy: string;
      facts: string;
      week: number;
      created_at: number;
    }>;
    bible: Array<{ id: number; entry: string; created_at: number }>;
    recaps: Array<{
      week: number;
      subject: string;
      body: string;
      facts: string;
      emailed_at: number | null;
      created_at: number;
    }>;
    settings: Array<{ key: string; value: string }>;
  };

  type TestBrain = {
    bootstrap: LeagueBrain["bootstrap"];
    getDashboard: LeagueBrain["getDashboard"];
    poll: LeagueBrain["poll"];
    attemptRecap: LeagueBrain["attemptRecap"];
    ingestSnapshot: LeagueBrain["ingestSnapshot"];
    exportLegacyStateFromSource(
      sleeperLeagueId: string,
      callerInternalLeagueId: string,
    ): Promise<LegacyBrainState | null>;
    legacyExportCalls?: number;
  };

  function legacyImportFailedLog(
    leagueId: string,
    attempt: number,
    reason: "error" | "unknown" = "error",
  ): unknown[] {
    return [
      JSON.stringify({
        event: "league_brain.legacy_import_failed",
        leagueId,
        attempt,
        max: LEGACY_IMPORT_MAX_ATTEMPTS,
        reason,
      }),
    ];
  }

  function legacyImportAbandonedLog(
    leagueId: string,
    attempt: number,
    reason: "error" | "unknown" = "error",
  ): unknown[] {
    return [
      JSON.stringify({
        event: "league_brain.legacy_import_abandoned",
        leagueId,
        attempt,
        max: LEGACY_IMPORT_MAX_ATTEMPTS,
        reason,
      }),
    ];
  }

  function expectSafeLegacyImportLogs(logged: unknown, forbidden: string[]): void {
    const serialized = JSON.stringify(logged);
    for (const token of forbidden) {
      expect(serialized).not.toContain(token);
    }
    const payloads = (Array.isArray(logged) ? logged : []).flat();
    for (const payload of payloads) {
      if (typeof payload !== "string") continue;
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([
        "attempt",
        "event",
        "leagueId",
        "max",
        "reason",
      ]);
      expect(parsed.reason === "error" || parsed.reason === "unknown").toBe(true);
    }
  }

  async function captureBootstrapLogs(
    stub: DurableObjectStub<LeagueBrain>,
    input: { leagueId: string; sleeperLeagueId: string; name: string; tone: "playful" },
  ): Promise<{ errors: unknown[][]; warns: unknown[][] }> {
    return runInDurableObject(stub, async (instance) => {
      const brain = instance as unknown as TestBrain;
      const errors: unknown[][] = [];
      const warns: unknown[][] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      console.error = ((...args: unknown[]) => {
        errors.push(args);
      }) as typeof console.error;
      console.warn = ((...args: unknown[]) => {
        warns.push(args);
      }) as typeof console.warn;
      try {
        await brain.bootstrap(input);
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
      }
      return { errors, warns };
    });
  }

  async function tryIngestSnapshot(
    stub: DurableObjectStub<LeagueBrain>,
    snap: LeagueSnapshot = snapshot(),
  ): Promise<{ wroteBeat: boolean; hash: string; facts: number } | { error: string }> {
    // Catch inside the DO isolate so a pending rejection is not an unhandled RPC error.
    return runInDurableObject(stub, async (instance) => {
      try {
        return await (instance as unknown as TestBrain).ingestSnapshot(snap, fixturePlayers);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  function expectEmptyHistory(sql: BrainSql): void {
    expect(sql.snapshots).toEqual([]);
    expect(sql.beats).toEqual([]);
    expect(sql.recaps).toEqual([]);
    expect(sql.bible).toEqual([]);
  }

  async function readBrainSql(stub: DurableObjectStub<LeagueBrain>): Promise<BrainSql> {
    return runInDurableObject(stub, async (_instance, state) => {
      return {
        snapshots: state.storage.sql
          .exec("SELECT id, week, payload_hash, payload, created_at FROM snapshots ORDER BY id")
          .toArray() as BrainSql["snapshots"],
        beats: state.storage.sql
          .exec("SELECT id, kind, copy, facts, week, created_at FROM beats ORDER BY id")
          .toArray() as BrainSql["beats"],
        bible: state.storage.sql
          .exec("SELECT id, entry, created_at FROM bible ORDER BY id")
          .toArray() as BrainSql["bible"],
        recaps: state.storage.sql
          .exec("SELECT week, subject, body, facts, emailed_at, created_at FROM recaps ORDER BY week")
          .toArray() as BrainSql["recaps"],
        settings: state.storage.sql
          .exec("SELECT key, value FROM settings ORDER BY key")
          .toArray() as BrainSql["settings"],
      };
    });
  }

  async function seedLegacyBrain(name: string, identity: { leagueId: string; sleeperLeagueId: string }): Promise<DurableObjectStub<LeagueBrain>> {
    const stub = env.LEAGUE_BRAIN.getByName(name);
    await runInDurableObject(stub, async (instance, state) => {
      const brain = instance as unknown as {
        putSetting(key: string, value: string): void;
      };
      brain.putSetting("leagueId", identity.leagueId);
      brain.putSetting("sleeperLeagueId", identity.sleeperLeagueId);
      brain.putSetting("name", "Legacy League");
      brain.putSetting("tone", "savage");
      state.storage.sql.exec(
        "INSERT INTO snapshots (id, week, payload_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        7,
        3,
        "hash-legacy-snap",
        JSON.stringify(LEGACY_SNAPSHOT),
        SNAPSHOT_CREATED_AT,
      );
      state.storage.sql.exec(
        "INSERT INTO beats (id, kind, copy, facts, week, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        4,
        "trade",
        "CeeDee walked so the chat could run.",
        LEGACY_FACTS,
        3,
        BEAT_CREATED_AT,
      );
      state.storage.sql.exec(
        "INSERT INTO bible (id, entry, created_at) VALUES (?, ?, ?)",
        9,
        "Week 2: the trade that split the group chat.",
        BIBLE_CREATED_AT,
      );
      state.storage.sql.exec(
        "INSERT INTO recaps (week, subject, body, facts, emailed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        3,
        "Week 3 belongs to Alex",
        "CeeDee changed hands and the chat lost its mind.",
        LEGACY_FACTS,
        RECAP_EMAILED_AT,
        RECAP_CREATED_AT,
      );
    });
    return stub;
  }

  it("copies snapshot, beat, bible, and recap from the Sleeper-named object into a distinct internal-named object", async () => {
    const legacy = await seedLegacyBrain(LEGACY_SLEEPER_ID, {
      leagueId: LEGACY_SLEEPER_ID,
      sleeperLeagueId: LEGACY_SLEEPER_ID,
    });
    const next = env.LEAGUE_BRAIN.getByName(INTERNAL_ID);

    await next.bootstrap({
      leagueId: INTERNAL_ID,
      sleeperLeagueId: LEGACY_SLEEPER_ID,
      name: "Cutman League",
      tone: "playful",
    });
    await next.bootstrap({
      leagueId: INTERNAL_ID,
      sleeperLeagueId: LEGACY_SLEEPER_ID,
      name: "Cutman League",
      tone: "playful",
    });

    const migrated = await readBrainSql(next);
    expect(migrated.snapshots).toEqual([
      {
        id: 7,
        week: 3,
        payload_hash: "hash-legacy-snap",
        payload: JSON.stringify(LEGACY_SNAPSHOT),
        created_at: SNAPSHOT_CREATED_AT,
      },
    ]);
    expect(migrated.beats).toEqual([
      {
        id: 4,
        kind: "trade",
        copy: "CeeDee walked so the chat could run.",
        facts: LEGACY_FACTS,
        week: 3,
        created_at: BEAT_CREATED_AT,
      },
    ]);
    expect(migrated.bible).toEqual([
      {
        id: 9,
        entry: "Week 2: the trade that split the group chat.",
        created_at: BIBLE_CREATED_AT,
      },
    ]);
    expect(migrated.recaps).toEqual([
      {
        week: 3,
        subject: "Week 3 belongs to Alex",
        body: "CeeDee changed hands and the chat lost its mind.",
        facts: LEGACY_FACTS,
        emailed_at: RECAP_EMAILED_AT,
        created_at: RECAP_CREATED_AT,
      },
    ]);
    expect(migrated.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: INTERNAL_ID },
        { key: "sleeperLeagueId", value: LEGACY_SLEEPER_ID },
        { key: "name", value: "Cutman League" },
        { key: "tone", value: "playful" },
        { key: "legacyMigratedFrom", value: LEGACY_SLEEPER_ID },
      ]),
    );
    expect(migrated.settings.some((row) => row.key === "legacyImportPending")).toBe(false);

    const dashboard = await next.getDashboard();
    expect(dashboard.leagueId).toBe(INTERNAL_ID);
    expect(dashboard.sleeperLeagueId).toBe(LEGACY_SLEEPER_ID);
    expect(dashboard.name).toBe("Cutman League");
    expect(dashboard.tone).toBe("playful");
    expect(dashboard.week).toBe(3);
    expect(dashboard.lastHash).toBe("hash-legacy-snap");
    expect(dashboard.timeline).toEqual([
      expect.objectContaining({
        id: 4,
        kind: "trade",
        copy: "CeeDee walked so the chat could run.",
        week: 3,
        createdAt: BEAT_CREATED_AT,
      }),
    ]);
    expect(dashboard.bible).toEqual([
      expect.objectContaining({
        id: 9,
        entry: "Week 2: the trade that split the group chat.",
        createdAt: BIBLE_CREATED_AT,
      }),
    ]);
    expect(dashboard.recaps).toEqual([
      expect.objectContaining({
        week: 3,
        subject: "Week 3 belongs to Alex",
        body: "CeeDee changed hands and the chat lost its mind.",
        createdAt: RECAP_CREATED_AT,
      }),
    ]);

    const exported = await legacy.exportLegacyState(LEGACY_SLEEPER_ID, INTERNAL_ID);
    expect(exported).not.toBeNull();
    expect(exported).not.toHaveProperty("settings");
    expect(exported?.sleeperLeagueId).toBe(LEGACY_SLEEPER_ID);
    expect(exported?.snapshots).toHaveLength(1);
    expect(exported?.beats).toHaveLength(1);
    expect(exported?.bible).toHaveLength(1);
    expect(exported?.recaps).toHaveLength(1);

    const leftover = await readBrainSql(legacy);
    expect(leftover.snapshots).toHaveLength(1);
    expect(leftover.beats).toHaveLength(1);
    expect(leftover.bible).toHaveLength(1);
    expect(leftover.recaps).toEqual([
      expect.objectContaining({ week: 3, emailed_at: RECAP_EMAILED_AT }),
    ]);
    expect(leftover.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: LEGACY_SLEEPER_ID },
        { key: "sleeperLeagueId", value: LEGACY_SLEEPER_ID },
        { key: "name", value: "Legacy League" },
        { key: "tone", value: "savage" },
      ]),
    );
  });

  it("does not import when the Sleeper-named object belongs to a different league or is empty", async () => {
    await seedLegacyBrain(MISMATCH_SLEEPER_NAME, {
      leagueId: "league_other_internal",
      sleeperLeagueId: OTHER_SLEEPER_ID,
    });
    const mismatched = env.LEAGUE_BRAIN.getByName(MISMATCH_INTERNAL_ID);
    await mismatched.bootstrap({
      leagueId: MISMATCH_INTERNAL_ID,
      sleeperLeagueId: MISMATCH_SLEEPER_NAME,
      name: "Cutman League",
      tone: "playful",
    });

    const ignored = await readBrainSql(mismatched);
    expect(ignored.snapshots).toEqual([]);
    expect(ignored.beats).toEqual([]);
    expect(ignored.recaps).toEqual([]);
    expect(ignored.bible).toEqual([
      expect.objectContaining({
        entry: "Cutman League is in the book. Tone: playful.",
      }),
    ]);
    expect(await env.LEAGUE_BRAIN.getByName(MISMATCH_SLEEPER_NAME).exportLegacyState(MISMATCH_SLEEPER_NAME, MISMATCH_INTERNAL_ID)).toBeNull();
    expect(await mismatched.exportLegacyState(MISMATCH_SLEEPER_NAME, MISMATCH_INTERNAL_ID)).toBeNull();

    const emptyTarget = env.LEAGUE_BRAIN.getByName(EMPTY_INTERNAL_ID);
    await emptyTarget.bootstrap({
      leagueId: EMPTY_INTERNAL_ID,
      sleeperLeagueId: EMPTY_SLEEPER_ID,
      name: "Fresh League",
      tone: "sportscenter",
    });
    const empty = await readBrainSql(emptyTarget);
    expect(empty.snapshots).toEqual([]);
    expect(empty.beats).toEqual([]);
    expect(empty.recaps).toEqual([]);
    expect(empty.bible).toHaveLength(1);
  });

  it("returns null from exportLegacyState for a wrong caller, new UUID, or source mismatch", async () => {
    const sleeperId = "900000000000000061";
    const mappedCaller = `legacy_${sleeperId}`;
    const source = await seedLegacyBrain(sleeperId, {
      leagueId: sleeperId,
      sleeperLeagueId: sleeperId,
    });

    const exported = await source.exportLegacyState(sleeperId, mappedCaller);
    expect(exported).not.toBeNull();
    expect(exported?.sleeperLeagueId).toBe(sleeperId);

    expect(await source.exportLegacyState(sleeperId, WRONG_CALLER_INTERNAL_ID)).toBeNull();
    expect(await source.exportLegacyState(sleeperId, NEW_UUID_INTERNAL_ID)).toBeNull();

    const mismatchSleeper = "900000000000000062";
    const mismatchSource = await seedLegacyBrain(mismatchSleeper, {
      leagueId: "league_other_internal",
      sleeperLeagueId: OTHER_SLEEPER_ID,
    });
    expect(await mismatchSource.exportLegacyState(mismatchSleeper, `legacy_${mismatchSleeper}`)).toBeNull();
  });

  it("does not import into a UUID-named destination even when the Sleeper-named source has history", async () => {
    const sleeperId = "900000000000000071";
    await seedLegacyBrain(sleeperId, {
      leagueId: sleeperId,
      sleeperLeagueId: sleeperId,
    });
    const next = env.LEAGUE_BRAIN.getByName(NEW_UUID_INTERNAL_ID);
    await next.bootstrap({
      leagueId: NEW_UUID_INTERNAL_ID,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    const ignored = await readBrainSql(next);
    expect(ignored.snapshots).toEqual([]);
    expect(ignored.beats).toEqual([]);
    expect(ignored.recaps).toEqual([]);
    expect(ignored.bible).toEqual([
      expect.objectContaining({
        entry: "Cutman League is in the book. Tone: playful.",
      }),
    ]);
  });

  it("logs unknown reason when the rejected export is not an Error", async () => {
    const sleeperId = "900000000000000081";
    const internalId = `legacy_${sleeperId}`;
    await seedLegacyBrain(sleeperId, {
      leagueId: sleeperId,
      sleeperLeagueId: sleeperId,
    });
    const next = env.LEAGUE_BRAIN.getByName(internalId);
    const input = {
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful" as const,
    };

    const logged = await runInDurableObject(next, async (instance) => {
      const brain = instance as unknown as TestBrain;
      brain.exportLegacyStateFromSource = async () => {
        throw "rpc rejected durable-object-id-secret";
      };
      const events: unknown[][] = [];
      const originalError = console.error;
      console.error = ((...args: unknown[]) => {
        events.push(args);
      }) as typeof console.error;
      try {
        await brain.bootstrap(input);
      } finally {
        console.error = originalError;
      }
      return events;
    });

    expect(logged).toEqual([legacyImportFailedLog(internalId, 1, "unknown")]);
    expectSafeLegacyImportLogs(logged, ["rpc rejected", "durable-object-id-secret"]);
    const pending = await readBrainSql(next);
    expect(pending.settings).toEqual(
      expect.arrayContaining([
        { key: "legacyImportPending", value: "1" },
        { key: "legacyImportFailureCount", value: "1" },
      ]),
    );
    expect(pending.settings.some((row) => row.key === "legacyMigratedFrom")).toBe(false);
  });

  it("catches a rejected legacy export, refuses history while pending, then imports on retry", async () => {
    const retrySleeperId = "900000000000000021";
    const retryInternalId = `legacy_${retrySleeperId}`;
    const leak = `rpc rejected ${retrySleeperId} durable-object-id-secret`;
    await seedLegacyBrain(retrySleeperId, {
      leagueId: retrySleeperId,
      sleeperLeagueId: retrySleeperId,
    });
    const next = env.LEAGUE_BRAIN.getByName(retryInternalId);
    const input = {
      leagueId: retryInternalId,
      sleeperLeagueId: retrySleeperId,
      name: "Cutman League",
      tone: "playful" as const,
    };

    const logged = await runInDurableObject(next, async (instance) => {
      const brain = instance as unknown as TestBrain;
      const original = brain.exportLegacyStateFromSource.bind(brain);
      let attempts = 0;
      brain.exportLegacyStateFromSource = async (sleeperLeagueId, callerInternalLeagueId) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error(leak);
        }
        return original(sleeperLeagueId, callerInternalLeagueId);
      };
      const events: unknown[][] = [];
      const originalError = console.error;
      console.error = ((...args: unknown[]) => {
        events.push(args);
      }) as typeof console.error;
      try {
        await brain.bootstrap(input);
      } finally {
        console.error = originalError;
      }
      return events;
    });

    expect(logged).toEqual([legacyImportFailedLog(retryInternalId, 1)]);
    // leagueId is `legacy_${sleeper}` (allowed). Forbid leak tokens, not the snowflake substring.
    expectSafeLegacyImportLogs(logged, ["rpc rejected", "durable-object-id-secret"]);

    const pending = await readBrainSql(next);
    expect(pending.snapshots).toEqual([]);
    expect(pending.beats).toEqual([]);
    expect(pending.recaps).toEqual([]);
    expect(pending.bible).toEqual([]);
    expect(pending.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: retryInternalId },
        { key: "sleeperLeagueId", value: retrySleeperId },
        { key: "name", value: "Cutman League" },
        { key: "tone", value: "playful" },
        { key: "legacyImportPending", value: "1" },
        { key: "legacyImportFailureCount", value: "1" },
      ]),
    );
    expect(pending.settings.some((row) => row.key === "legacyMigratedFrom")).toBe(false);
    expect(pending.settings.some((row) => row.key === "legacyImportAbandoned")).toBe(false);

    const refusals = await runInDurableObject(next, async (instance) => {
      const brain = instance as unknown as TestBrain;
      const messages: { dashboard?: string; poll?: string; recap?: string; ingest?: string } = {};
      try {
        await brain.getDashboard();
      } catch (error) {
        messages.dashboard = error instanceof Error ? error.message : String(error);
      }
      try {
        await brain.poll();
      } catch (error) {
        messages.poll = error instanceof Error ? error.message : String(error);
      }
      try {
        await brain.attemptRecap();
      } catch (error) {
        messages.recap = error instanceof Error ? error.message : String(error);
      }
      try {
        await brain.ingestSnapshot(snapshot(), fixturePlayers);
      } catch (error) {
        messages.ingest = error instanceof Error ? error.message : String(error);
      }
      return messages;
    });
    expect(refusals).toEqual({
      dashboard: LEGACY_IMPORT_PENDING_MESSAGE,
      poll: LEGACY_IMPORT_PENDING_MESSAGE,
      recap: LEGACY_IMPORT_PENDING_MESSAGE,
      ingest: LEGACY_IMPORT_PENDING_MESSAGE,
    });
    const stillPending = await readBrainSql(next);
    expect(stillPending.snapshots).toEqual([]);
    expect(stillPending.beats).toEqual([]);
    expect(stillPending.recaps).toEqual([]);
    expect(stillPending.bible).toEqual([]);
    expect(stillPending.settings.some((row) => row.key === "legacyImportPending")).toBe(true);

    await expect(next.bootstrap(input)).resolves.toBeUndefined();

    const migrated = await readBrainSql(next);
    expect(migrated.snapshots).toEqual([
      {
        id: 7,
        week: 3,
        payload_hash: "hash-legacy-snap",
        payload: JSON.stringify(LEGACY_SNAPSHOT),
        created_at: SNAPSHOT_CREATED_AT,
      },
    ]);
    expect(migrated.beats).toEqual([
      {
        id: 4,
        kind: "trade",
        copy: "CeeDee walked so the chat could run.",
        facts: LEGACY_FACTS,
        week: 3,
        created_at: BEAT_CREATED_AT,
      },
    ]);
    expect(migrated.bible).toEqual([
      {
        id: 9,
        entry: "Week 2: the trade that split the group chat.",
        created_at: BIBLE_CREATED_AT,
      },
    ]);
    expect(migrated.recaps).toEqual([
      {
        week: 3,
        subject: "Week 3 belongs to Alex",
        body: "CeeDee changed hands and the chat lost its mind.",
        facts: LEGACY_FACTS,
        emailed_at: RECAP_EMAILED_AT,
        created_at: RECAP_CREATED_AT,
      },
    ]);
    expect(migrated.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: retryInternalId },
        { key: "sleeperLeagueId", value: retrySleeperId },
        { key: "name", value: "Cutman League" },
        { key: "tone", value: "playful" },
        { key: "legacyMigratedFrom", value: retrySleeperId },
      ]),
    );
    expect(migrated.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
    expect(migrated.settings.some((row) => row.key === "legacyImportFailureCount")).toBe(false);
    expect(migrated.settings.some((row) => row.key === "legacyImportAbandoned")).toBe(false);

    const dashboard = await next.getDashboard();
    expect(dashboard.bible).toEqual([
      expect.objectContaining({
        id: 9,
        entry: "Week 2: the trade that split the group chat.",
        createdAt: BIBLE_CREATED_AT,
      }),
    ]);
    expect(dashboard.recaps).toEqual([
      expect.objectContaining({
        week: 3,
        subject: "Week 3 belongs to Alex",
        body: "CeeDee changed hands and the chat lost its mind.",
        createdAt: RECAP_CREATED_AT,
      }),
    ]);

    await expect(next.bootstrap(input)).resolves.toBeUndefined();
    const again = await readBrainSql(next);
    expect(again.snapshots).toEqual(migrated.snapshots);
    expect(again.beats).toEqual(migrated.beats);
    expect(again.bible).toEqual(migrated.bible);
    expect(again.recaps).toEqual(migrated.recaps);
    expect(again.settings).toEqual(migrated.settings);
  });

  it("abandons legacy import after consecutive failures and then bootstraps a fresh book", async () => {
    const abandonSleeperId = "900000000000000031";
    const abandonInternalId = `legacy_${abandonSleeperId}`;
    const leak = `rpc rejected ${abandonSleeperId} durable-object-id-secret`;
    await seedLegacyBrain(abandonSleeperId, {
      leagueId: abandonSleeperId,
      sleeperLeagueId: abandonSleeperId,
    });
    const next = env.LEAGUE_BRAIN.getByName(abandonInternalId);
    const input = {
      leagueId: abandonInternalId,
      sleeperLeagueId: abandonSleeperId,
      name: "Cutman League",
      tone: "playful" as const,
    };

    await runInDurableObject(next, async (instance) => {
      const brain = instance as unknown as TestBrain;
      brain.legacyExportCalls = 0;
      brain.exportLegacyStateFromSource = async () => {
        brain.legacyExportCalls = (brain.legacyExportCalls ?? 0) + 1;
        throw new Error(leak);
      };
    });

    const forbidden = ["rpc rejected", "durable-object-id-secret"];
    const exportCalls = (): Promise<number> =>
      runInDurableObject(next, async (instance) => (instance as unknown as TestBrain).legacyExportCalls ?? 0);

    const first = await captureBootstrapLogs(next, input);
    expect(first.errors).toEqual([legacyImportFailedLog(abandonInternalId, 1)]);
    expect(first.warns).toEqual([]);
    expectSafeLegacyImportLogs(first.errors, forbidden);
    const afterFirst = await readBrainSql(next);
    expect(afterFirst.snapshots).toEqual([]);
    expect(afterFirst.beats).toEqual([]);
    expect(afterFirst.recaps).toEqual([]);
    expect(afterFirst.bible).toEqual([]);
    expect(afterFirst.settings).toEqual(
      expect.arrayContaining([
        { key: "legacyImportPending", value: "1" },
        { key: "legacyImportFailureCount", value: "1" },
      ]),
    );
    expect(afterFirst.settings.some((row) => row.key === "legacyMigratedFrom")).toBe(false);
    expect(afterFirst.settings.some((row) => row.key === "legacyImportAbandoned")).toBe(false);
    expect(
      await runInDurableObject(next, async (instance) => {
        try {
          await (instance as unknown as TestBrain).getDashboard();
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }),
    ).toBe(LEGACY_IMPORT_PENDING_MESSAGE);
    expect(await exportCalls()).toBe(1);

    const second = await captureBootstrapLogs(next, input);
    expect(second.errors).toEqual([legacyImportFailedLog(abandonInternalId, 2)]);
    expect(second.warns).toEqual([]);
    expectSafeLegacyImportLogs(second.errors, forbidden);
    const afterSecond = await readBrainSql(next);
    expect(afterSecond.snapshots).toEqual([]);
    expect(afterSecond.beats).toEqual([]);
    expect(afterSecond.recaps).toEqual([]);
    expect(afterSecond.bible).toEqual([]);
    expect(afterSecond.settings).toEqual(
      expect.arrayContaining([
        { key: "legacyImportPending", value: "1" },
        { key: "legacyImportFailureCount", value: "2" },
      ]),
    );
    expect(afterSecond.settings.some((row) => row.key === "legacyImportAbandoned")).toBe(false);
    expect(
      await runInDurableObject(next, async (instance) => {
        try {
          await (instance as unknown as TestBrain).getDashboard();
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }),
    ).toBe(LEGACY_IMPORT_PENDING_MESSAGE);
    expect(await exportCalls()).toBe(2);

    const third = await captureBootstrapLogs(next, input);
    expect(third.errors).toEqual([legacyImportFailedLog(abandonInternalId, LEGACY_IMPORT_MAX_ATTEMPTS)]);
    expect(third.warns).toEqual([legacyImportAbandonedLog(abandonInternalId, LEGACY_IMPORT_MAX_ATTEMPTS)]);
    expectSafeLegacyImportLogs([...third.errors, ...third.warns], forbidden);
    const afterThird = await readBrainSql(next);
    expect(afterThird.snapshots).toEqual([]);
    expect(afterThird.beats).toEqual([]);
    expect(afterThird.recaps).toEqual([]);
    expect(afterThird.bible).toEqual([
      expect.objectContaining({
        entry: "Cutman League is in the book. Tone: playful.",
      }),
    ]);
    expect(afterThird.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: abandonInternalId },
        { key: "sleeperLeagueId", value: abandonSleeperId },
        { key: "legacyImportAbandoned", value: "1" },
        { key: "legacyImportFailureCount", value: String(LEGACY_IMPORT_MAX_ATTEMPTS) },
      ]),
    );
    expect(afterThird.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
    expect(afterThird.settings.some((row) => row.key === "legacyMigratedFrom")).toBe(false);

    const dashboard = await next.getDashboard();
    expect(dashboard.leagueId).toBe(abandonInternalId);
    expect(dashboard.bible).toEqual([
      expect.objectContaining({
        entry: "Cutman League is in the book. Tone: playful.",
      }),
    ]);
    expect(dashboard.timeline).toEqual([]);
    expect(dashboard.recaps).toEqual([]);

    expect(await exportCalls()).toBe(LEGACY_IMPORT_MAX_ATTEMPTS);

    const fourth = await captureBootstrapLogs(next, input);
    expect(fourth.errors).toEqual([]);
    expect(fourth.warns).toEqual([]);
    expect(await exportCalls()).toBe(LEGACY_IMPORT_MAX_ATTEMPTS);
    const afterFourth = await readBrainSql(next);
    expect(afterFourth.bible).toEqual(afterThird.bible);
    expect(afterFourth.snapshots).toEqual([]);
    expect(afterFourth.settings.some((row) => row.key === "legacyImportAbandoned")).toBe(true);
    expect(afterFourth.settings.some((row) => row.key === "legacyMigratedFrom")).toBe(false);
    expect(afterFourth.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
  });

  it("ingestSnapshot rejects while pending and writes nothing, then writes after a successful retry", async () => {
    const retrySleeperId = "900000000000000041";
    const retryInternalId = `legacy_${retrySleeperId}`;
    await seedLegacyBrain(retrySleeperId, {
      leagueId: retrySleeperId,
      sleeperLeagueId: retrySleeperId,
    });
    const next = env.LEAGUE_BRAIN.getByName(retryInternalId);
    const input = {
      leagueId: retryInternalId,
      sleeperLeagueId: retrySleeperId,
      name: "Cutman League",
      tone: "playful" as const,
    };

    await runInDurableObject(next, async (instance) => {
      const brain = instance as unknown as TestBrain;
      const original = brain.exportLegacyStateFromSource.bind(brain);
      let attempts = 0;
      brain.exportLegacyStateFromSource = async (sleeperLeagueId, callerInternalLeagueId) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("export unavailable");
        }
        return original(sleeperLeagueId, callerInternalLeagueId);
      };
    });
    await captureBootstrapLogs(next, input);

    expectEmptyHistory(await readBrainSql(next));
    const pendingIngest = await tryIngestSnapshot(next);
    expect(pendingIngest).toEqual({ error: LEGACY_IMPORT_PENDING_MESSAGE });
    expectEmptyHistory(await readBrainSql(next));

    await expect(next.bootstrap(input)).resolves.toBeUndefined();
    expect((await readBrainSql(next)).settings.some((row) => row.key === "legacyImportPending")).toBe(false);

    const afterRetry = await tryIngestSnapshot(next);
    expect(afterRetry).not.toHaveProperty("error");
    expect(afterRetry).toEqual(
      expect.objectContaining({
        hash: expect.any(String),
        facts: expect.any(Number),
        wroteBeat: expect.any(Boolean),
      }),
    );
    const written = await readBrainSql(next);
    expect(written.snapshots.length).toBeGreaterThan(0);
    expect(written.snapshots.some((row) => row.payload === JSON.stringify(snapshot()))).toBe(true);
  });

  it("ingestSnapshot rejects while pending and writes nothing, then writes after abandonment", async () => {
    const abandonSleeperId = "900000000000000051";
    const abandonInternalId = `legacy_${abandonSleeperId}`;
    const next = env.LEAGUE_BRAIN.getByName(abandonInternalId);
    const input = {
      leagueId: abandonInternalId,
      sleeperLeagueId: abandonSleeperId,
      name: "Cutman League",
      tone: "playful" as const,
    };

    await runInDurableObject(next, async (instance) => {
      const brain = instance as unknown as TestBrain;
      brain.exportLegacyStateFromSource = async () => {
        throw new Error("export unavailable");
      };
    });

    for (let attempt = 1; attempt < LEGACY_IMPORT_MAX_ATTEMPTS; attempt += 1) {
      await captureBootstrapLogs(next, input);
      expectEmptyHistory(await readBrainSql(next));
      const pendingIngest = await tryIngestSnapshot(next);
      expect(pendingIngest).toEqual({ error: LEGACY_IMPORT_PENDING_MESSAGE });
      expectEmptyHistory(await readBrainSql(next));
    }

    await captureBootstrapLogs(next, input);
    const abandoned = await readBrainSql(next);
    expect(abandoned.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
    expect(abandoned.settings.some((row) => row.key === "legacyImportAbandoned")).toBe(true);
    expect(abandoned.snapshots).toEqual([]);
    expect(abandoned.beats).toEqual([]);
    expect(abandoned.recaps).toEqual([]);

    const afterAbandon = await tryIngestSnapshot(next);
    expect(afterAbandon).not.toHaveProperty("error");
    expect(afterAbandon).toEqual(
      expect.objectContaining({
        hash: expect.any(String),
        facts: expect.any(Number),
        wroteBeat: expect.any(Boolean),
      }),
    );
    const written = await readBrainSql(next);
    expect(written.snapshots).toHaveLength(1);
    expect(written.snapshots[0]?.payload).toBe(JSON.stringify(snapshot()));
  });
});
