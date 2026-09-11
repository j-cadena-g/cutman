/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import {
  activateLeague,
  createLeague,
  ensureSchema,
  getLeague,
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
    hasHistoricalRows(): boolean;
    legacyExportCalls?: number;
  };

  function legacyImportFailedLog(
    attempt: number,
    reason: "error" | "unknown" = "error",
  ): unknown[] {
    return [
      JSON.stringify({
        event: "league_brain.legacy_import_failed",
        attempt,
        max: LEGACY_IMPORT_MAX_ATTEMPTS,
        reason,
      }),
    ];
  }

  function legacyImportAbandonedLog(
    attempt: number,
    reason: "error" | "unknown" = "error",
  ): unknown[] {
    return [
      JSON.stringify({
        event: "league_brain.legacy_import_abandoned",
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
    expect(serialized).not.toMatch(/\d{6,}/);
    const payloads = (Array.isArray(logged) ? logged : []).flat();
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      if (typeof payload !== "string") continue;
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["attempt", "event", "max", "reason"]);
      expect(["league_brain.legacy_import_failed", "league_brain.legacy_import_abandoned"]).toContain(parsed.event);
      expect(typeof parsed.attempt).toBe("number");
      expect(parsed.max).toBe(LEGACY_IMPORT_MAX_ATTEMPTS);
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

  async function putBrainSettings(
    stub: DurableObjectStub<LeagueBrain>,
    settings: { name: string; tone: string },
  ): Promise<void> {
    await runInDurableObject(stub, async (instance) => {
      const brain = instance as unknown as { putSetting(key: string, value: string): void };
      brain.putSetting("name", settings.name);
      brain.putSetting("tone", settings.tone);
    });
  }

  async function insertBible(
    stub: DurableObjectStub<LeagueBrain>,
    entry: string,
    createdAt = BIBLE_CREATED_AT,
  ): Promise<void> {
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO bible (entry, created_at) VALUES (?, ?)", entry, createdAt);
    });
  }

  async function seedExactBootstrapBible(
    stub: DurableObjectStub<LeagueBrain>,
    name: string,
    tone: "playful" | "savage" | "sportscenter",
  ): Promise<void> {
    await putBrainSettings(stub, { name, tone });
    await insertBible(stub, `${name} is in the book. Tone: ${tone}.`);
  }

  async function putLegacyImportPending(stub: DurableObjectStub<LeagueBrain>): Promise<void> {
    await runInDurableObject(stub, async (instance) => {
      const brain = instance as unknown as { putSetting(key: string, value: string): void };
      brain.putSetting("legacyImportPending", "1");
    });
  }

  async function seedIdenticalLegacyHistory(stub: DurableObjectStub<LeagueBrain>): Promise<void> {
    await runInDurableObject(stub, async (_instance, state) => {
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
  }

  async function historicalRows(stub: DurableObjectStub<LeagueBrain>): Promise<boolean> {
    return runInDurableObject(stub, async (instance) => (instance as unknown as TestBrain).hasHistoricalRows());
  }

  async function instrumentLegacyExport(stub: DurableObjectStub<LeagueBrain>): Promise<void> {
    await runInDurableObject(stub, async (instance) => {
      const brain = instance as unknown as TestBrain;
      const original = brain.exportLegacyStateFromSource.bind(brain);
      brain.legacyExportCalls = 0;
      brain.exportLegacyStateFromSource = async (sleeperLeagueId, callerInternalLeagueId) => {
        brain.legacyExportCalls = (brain.legacyExportCalls ?? 0) + 1;
        return original(sleeperLeagueId, callerInternalLeagueId);
      };
    });
  }

  async function legacyExportCallCount(stub: DurableObjectStub<LeagueBrain>): Promise<number> {
    return runInDurableObject(stub, async (instance) => (instance as unknown as TestBrain).legacyExportCalls ?? 0);
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

  it("skips the Sleeper-named source RPC and marks complete for a non-legacy internal id", async () => {
    const sleeperId = "900000000000000072";
    const freshId = "660e8400-e29b-41d4-a716-446655440001";
    await seedLegacyBrain(sleeperId, {
      leagueId: sleeperId,
      sleeperLeagueId: sleeperId,
    });
    const next = env.LEAGUE_BRAIN.getByName(freshId);
    await instrumentLegacyExport(next);
    await next.bootstrap({
      leagueId: freshId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(0);
    const ignored = await readBrainSql(next);
    expect(ignored.snapshots).toEqual([]);
    expect(ignored.beats).toEqual([]);
    expect(ignored.recaps).toEqual([]);
    expect(ignored.bible).toEqual([
      expect.objectContaining({
        entry: "Cutman League is in the book. Tone: playful.",
      }),
    ]);
    expect(ignored.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: freshId },
        { key: "sleeperLeagueId", value: sleeperId },
        { key: "legacyMigratedFrom", value: sleeperId },
      ]),
    );
    expect(ignored.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
    expect(ignored.settings.some((row) => row.key === "legacyImportFailureCount")).toBe(false);
  });

  it("still exports from the Sleeper-named source into the mapped legacy destination", async () => {
    const sleeperId = "900000000000000073";
    const mappedId = `legacy_${sleeperId}`;
    await seedLegacyBrain(sleeperId, {
      leagueId: sleeperId,
      sleeperLeagueId: sleeperId,
    });
    const next = env.LEAGUE_BRAIN.getByName(mappedId);
    await instrumentLegacyExport(next);
    await next.bootstrap({
      leagueId: mappedId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(1);
    const migrated = await readBrainSql(next);
    expect(migrated.snapshots).toHaveLength(1);
    expect(migrated.beats).toHaveLength(1);
    expect(migrated.bible).toEqual([
      expect.objectContaining({
        entry: "Week 2: the trade that split the group chat.",
      }),
    ]);
    expect(migrated.recaps).toHaveLength(1);
    expect(migrated.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: mappedId },
        { key: "sleeperLeagueId", value: sleeperId },
        { key: "legacyMigratedFrom", value: sleeperId },
      ]),
    );
    expect(migrated.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
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

    expect(logged).toEqual([legacyImportFailedLog(1, "unknown")]);
    expectSafeLegacyImportLogs(logged, [internalId, sleeperId, "rpc rejected", "durable-object-id-secret"]);
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

    expect(logged).toEqual([legacyImportFailedLog(1)]);
    expectSafeLegacyImportLogs(logged, [retryInternalId, retrySleeperId, "rpc rejected", "durable-object-id-secret"]);

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

  it("marks import pending before the source export await so concurrent reads observe it", async () => {
    const sleeperId = "900000000000000101";
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

    await runInDurableObject(next, async (instance) => {
      const brain = instance as unknown as TestBrain;
      const original = brain.exportLegacyStateFromSource.bind(brain);
      let releaseExport!: () => void;
      let signalStarted!: () => void;
      const exportStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const exportGate = new Promise<void>((resolve) => {
        releaseExport = resolve;
      });
      brain.exportLegacyStateFromSource = async (sleeperLeagueId, callerInternalLeagueId) => {
        signalStarted();
        await exportGate;
        return original(sleeperLeagueId, callerInternalLeagueId);
      };

      const bootstrapPromise = brain.bootstrap(input);
      await exportStarted;

      const refusals: { dashboard?: string; poll?: string } = {};
      try {
        await brain.getDashboard();
      } catch (error) {
        refusals.dashboard = error instanceof Error ? error.message : String(error);
      }
      try {
        await brain.poll();
      } catch (error) {
        refusals.poll = error instanceof Error ? error.message : String(error);
      }
      expect(refusals).toEqual({
        dashboard: LEGACY_IMPORT_PENDING_MESSAGE,
        poll: LEGACY_IMPORT_PENDING_MESSAGE,
      });

      releaseExport();
      await bootstrapPromise;
    });

    const migrated = await readBrainSql(next);
    expect(migrated.snapshots).toEqual([
      expect.objectContaining({
        id: 7,
        payload_hash: "hash-legacy-snap",
      }),
    ]);
    expect(migrated.beats).toHaveLength(1);
    expect(migrated.bible).toEqual([
      expect.objectContaining({
        entry: "Week 2: the trade that split the group chat.",
      }),
    ]);
    expect(migrated.recaps).toHaveLength(1);
    expect(migrated.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: internalId },
        { key: "sleeperLeagueId", value: sleeperId },
        { key: "legacyMigratedFrom", value: sleeperId },
      ]),
    );
    expect(migrated.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
    expect(migrated.settings.some((row) => row.key === "legacyImportFailureCount")).toBe(false);
    await expect(next.getDashboard()).resolves.toEqual(
      expect.objectContaining({
        leagueId: internalId,
        sleeperLeagueId: sleeperId,
      }),
    );
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

    const forbidden = [abandonInternalId, abandonSleeperId, "rpc rejected", "durable-object-id-secret"];
    const exportCalls = (): Promise<number> =>
      runInDurableObject(next, async (instance) => (instance as unknown as TestBrain).legacyExportCalls ?? 0);

    const first = await captureBootstrapLogs(next, input);
    expect(first.errors).toEqual([legacyImportFailedLog(1)]);
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
    expect(second.errors).toEqual([legacyImportFailedLog(2)]);
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
    expect(third.errors).toEqual([legacyImportFailedLog(LEGACY_IMPORT_MAX_ATTEMPTS)]);
    expect(third.warns).toEqual([legacyImportAbandonedLog(LEGACY_IMPORT_MAX_ATTEMPTS)]);
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

  it("hasHistoricalRows ignores the bootstrap bible seed and counts real history", async () => {
    const empty = env.LEAGUE_BRAIN.getByName("historical-rows-empty");
    expect(await historicalRows(empty)).toBe(false);

    const seedOnly = env.LEAGUE_BRAIN.getByName("historical-rows-seed");
    await seedExactBootstrapBible(seedOnly, "Cutman League", "playful");
    expect(await historicalRows(seedOnly)).toBe(false);

    const savageSeed = env.LEAGUE_BRAIN.getByName("historical-rows-seed-savage");
    await seedExactBootstrapBible(savageSeed, "Legacy League", "savage");
    expect(await historicalRows(savageSeed)).toBe(false);

    const sportscenterSeed = env.LEAGUE_BRAIN.getByName("historical-rows-seed-sportscenter");
    await seedExactBootstrapBible(sportscenterSeed, "Broadcast League", "sportscenter");
    expect(await historicalRows(sportscenterSeed)).toBe(false);

    const bootstrappedSeed = env.LEAGUE_BRAIN.getByName("historical-rows-bootstrapped-seed");
    await bootstrappedSeed.bootstrap({
      leagueId: "historical-rows-bootstrapped-seed",
      sleeperLeagueId: "historical-rows-bootstrapped-seed",
      name: "Cutman League",
      tone: "playful",
    });
    expect(await historicalRows(bootstrappedSeed)).toBe(false);

    const missingSettings = env.LEAGUE_BRAIN.getByName("historical-rows-missing-settings");
    await insertBible(missingSettings, "Cutman League is in the book. Tone: playful.");
    expect(await historicalRows(missingSettings)).toBe(true);

    const mismatchedSeed = env.LEAGUE_BRAIN.getByName("historical-rows-mismatched-seed");
    await putBrainSettings(mismatchedSeed, { name: "Cutman League", tone: "playful" });
    await insertBible(mismatchedSeed, "Other League is in the book. Tone: savage.");
    expect(await historicalRows(mismatchedSeed)).toBe(true);

    const invalidTone = env.LEAGUE_BRAIN.getByName("historical-rows-invalid-tone");
    await putBrainSettings(invalidTone, { name: "Cutman League", tone: "mysterious" });
    await insertBible(invalidTone, "Cutman League is in the book. Tone: mysterious.");
    expect(await historicalRows(invalidTone)).toBe(true);

    const userBible = env.LEAGUE_BRAIN.getByName("historical-rows-user-bible");
    await insertBible(userBible, "Week 2: the trade that split the group chat.");
    expect(await historicalRows(userBible)).toBe(true);

    const recapBible = env.LEAGUE_BRAIN.getByName("historical-rows-recap-bible");
    await insertBible(recapBible, "Week 3 recap: Week 3 belongs to Alex");
    expect(await historicalRows(recapBible)).toBe(true);

    const seedAndUser = env.LEAGUE_BRAIN.getByName("historical-rows-seed-and-user");
    await seedExactBootstrapBible(seedAndUser, "Cutman League", "playful");
    await insertBible(seedAndUser, "Week 2: the trade that split the group chat.", BIBLE_CREATED_AT + 1);
    expect(await historicalRows(seedAndUser)).toBe(true);

    const snapshotOnly = env.LEAGUE_BRAIN.getByName("historical-rows-snapshot");
    await runInDurableObject(snapshotOnly, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO snapshots (week, payload_hash, payload, created_at) VALUES (?, ?, ?, ?)",
        3,
        "hash-legacy-snap",
        JSON.stringify(LEGACY_SNAPSHOT),
        SNAPSHOT_CREATED_AT,
      );
    });
    expect(await historicalRows(snapshotOnly)).toBe(true);

    const beatOnly = env.LEAGUE_BRAIN.getByName("historical-rows-beat");
    await runInDurableObject(beatOnly, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO beats (kind, copy, facts, week, created_at) VALUES (?, ?, ?, ?, ?)",
        "trade",
        "CeeDee walked so the chat could run.",
        LEGACY_FACTS,
        3,
        BEAT_CREATED_AT,
      );
    });
    expect(await historicalRows(beatOnly)).toBe(true);

    const recapOnly = env.LEAGUE_BRAIN.getByName("historical-rows-recap");
    await runInDurableObject(recapOnly, async (_instance, state) => {
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
    expect(await historicalRows(recapOnly)).toBe(true);

    const seedPlusSnapshot = env.LEAGUE_BRAIN.getByName("historical-rows-seed-plus-snapshot");
    await seedExactBootstrapBible(seedPlusSnapshot, "Cutman League", "playful");
    await runInDurableObject(seedPlusSnapshot, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO snapshots (week, payload_hash, payload, created_at) VALUES (?, ?, ?, ?)",
        3,
        "hash-legacy-snap",
        JSON.stringify(LEGACY_SNAPSHOT),
        SNAPSHOT_CREATED_AT,
      );
    });
    expect(await historicalRows(seedPlusSnapshot)).toBe(true);
  });

  it("treats a seed-looking bible row as history when it does not match stored settings", async () => {
    const sleeperId = "900000000000000095";
    const internalId = `legacy_${sleeperId}`;
    await seedLegacyBrain(sleeperId, { leagueId: sleeperId, sleeperLeagueId: sleeperId });
    const next = env.LEAGUE_BRAIN.getByName(internalId);
    await putBrainSettings(next, { name: "Cutman League", tone: "playful" });
    await insertBible(next, "Other League is in the book. Tone: savage.");
    expect(await historicalRows(next)).toBe(true);
    await instrumentLegacyExport(next);

    await next.bootstrap({
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(0);
    const kept = await readBrainSql(next);
    expect(kept.snapshots).toEqual([]);
    expect(kept.bible).toEqual([
      expect.objectContaining({ entry: "Other League is in the book. Tone: savage." }),
    ]);
    expect(kept.settings).toEqual(
      expect.arrayContaining([{ key: "legacyMigratedFrom", value: sleeperId }]),
    );
  });

  it("still exports into a destination that only has the bootstrap bible seed", async () => {
    const sleeperId = "900000000000000091";
    const internalId = `legacy_${sleeperId}`;
    await seedLegacyBrain(sleeperId, { leagueId: sleeperId, sleeperLeagueId: sleeperId });
    const next = env.LEAGUE_BRAIN.getByName(internalId);
    await seedExactBootstrapBible(next, "Cutman League", "playful");
    expect(await historicalRows(next)).toBe(false);
    await instrumentLegacyExport(next);

    await next.bootstrap({
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(1);
    const migrated = await readBrainSql(next);
    expect(migrated.snapshots).toEqual([
      expect.objectContaining({ id: 7, payload_hash: "hash-legacy-snap" }),
    ]);
    expect(migrated.beats).toEqual([
      expect.objectContaining({ id: 4, copy: "CeeDee walked so the chat could run." }),
    ]);
    expect(migrated.recaps).toEqual([
      expect.objectContaining({ week: 3, subject: "Week 3 belongs to Alex" }),
    ]);
    expect(migrated.bible).toEqual([
      {
        id: 9,
        entry: "Week 2: the trade that split the group chat.",
        created_at: BIBLE_CREATED_AT,
      },
    ]);
    expect(migrated.bible.some((row) => row.entry === "Cutman League is in the book. Tone: playful.")).toBe(
      false,
    );
    expect(migrated.settings).toEqual(
      expect.arrayContaining([{ key: "legacyMigratedFrom", value: sleeperId }]),
    );
    expect(migrated.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
  });

  it("skips export when the destination already has user-created bible history", async () => {
    const sleeperId = "900000000000000092";
    const internalId = `legacy_${sleeperId}`;
    await seedLegacyBrain(sleeperId, { leagueId: sleeperId, sleeperLeagueId: sleeperId });
    const next = env.LEAGUE_BRAIN.getByName(internalId);
    await insertBible(next, "Week 2: the trade that split the group chat.");
    expect(await historicalRows(next)).toBe(true);
    await instrumentLegacyExport(next);

    await next.bootstrap({
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(0);
    const kept = await readBrainSql(next);
    expect(kept.snapshots).toEqual([]);
    expect(kept.beats).toEqual([]);
    expect(kept.recaps).toEqual([]);
    expect(kept.bible).toEqual([
      expect.objectContaining({ entry: "Week 2: the trade that split the group chat." }),
    ]);
    expect(kept.settings).toEqual(
      expect.arrayContaining([{ key: "legacyMigratedFrom", value: sleeperId }]),
    );
  });

  it("skips export when the destination has recap bible history even if a seed is also present", async () => {
    const sleeperId = "900000000000000093";
    const internalId = `legacy_${sleeperId}`;
    await seedLegacyBrain(sleeperId, { leagueId: sleeperId, sleeperLeagueId: sleeperId });
    const next = env.LEAGUE_BRAIN.getByName(internalId);
    await seedExactBootstrapBible(next, "Cutman League", "playful");
    await insertBible(next, "Week 3 recap: Week 3 belongs to Alex", BIBLE_CREATED_AT + 1);
    expect(await historicalRows(next)).toBe(true);
    await instrumentLegacyExport(next);

    await next.bootstrap({
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(0);
    const kept = await readBrainSql(next);
    expect(kept.snapshots).toEqual([]);
    expect(kept.bible).toEqual([
      expect.objectContaining({ entry: "Cutman League is in the book. Tone: playful." }),
      expect.objectContaining({ entry: "Week 3 recap: Week 3 belongs to Alex" }),
    ]);
    expect(kept.settings).toEqual(
      expect.arrayContaining([{ key: "legacyMigratedFrom", value: sleeperId }]),
    );
  });

  it("exports a seed-only legacy source into an empty destination and marks import complete", async () => {
    const sleeperId = "900000000000000094";
    const internalId = `legacy_${sleeperId}`;
    const source = env.LEAGUE_BRAIN.getByName(sleeperId);
    await source.bootstrap({
      leagueId: sleeperId,
      sleeperLeagueId: sleeperId,
      name: "Legacy League",
      tone: "savage",
    });
    const sourceSql = await readBrainSql(source);
    expect(sourceSql.snapshots).toEqual([]);
    expect(sourceSql.beats).toEqual([]);
    expect(sourceSql.recaps).toEqual([]);
    expect(sourceSql.bible).toEqual([
      expect.objectContaining({ entry: "Legacy League is in the book. Tone: savage." }),
    ]);

    const next = env.LEAGUE_BRAIN.getByName(internalId);
    await instrumentLegacyExport(next);
    await next.bootstrap({
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(1);
    const migrated = await readBrainSql(next);
    expect(migrated.snapshots).toEqual([]);
    expect(migrated.beats).toEqual([]);
    expect(migrated.recaps).toEqual([]);
    expect(migrated.bible).toEqual([
      expect.objectContaining({ entry: "Legacy League is in the book. Tone: savage." }),
    ]);
    expect(migrated.settings).toEqual(
      expect.arrayContaining([
        { key: "leagueId", value: internalId },
        { key: "sleeperLeagueId", value: sleeperId },
        { key: "legacyMigratedFrom", value: sleeperId },
      ]),
    );
  });

  it("rolls back every copied row and skips the completion marker when a PK already holds a different row", async () => {
    const sleeperId = "900000000000000096";
    const internalId = `legacy_${sleeperId}`;
    await seedLegacyBrain(sleeperId, { leagueId: sleeperId, sleeperLeagueId: sleeperId });
    const next = env.LEAGUE_BRAIN.getByName(internalId);
    await seedExactBootstrapBible(next, "Cutman League", "playful");
    await putLegacyImportPending(next);
    await runInDurableObject(next, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO recaps (week, subject, body, facts, emailed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        3,
        "Dest already wrote a different week 3 recap",
        "This must not be overwritten, and source snapshots must not stick.",
        LEGACY_FACTS,
        RECAP_EMAILED_AT,
        RECAP_CREATED_AT,
      );
    });
    await instrumentLegacyExport(next);

    await next.bootstrap({
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(1);
    const rolledBack = await readBrainSql(next);
    expect(rolledBack.snapshots).toEqual([]);
    expect(rolledBack.beats).toEqual([]);
    expect(rolledBack.bible).toEqual([
      expect.objectContaining({ entry: "Cutman League is in the book. Tone: playful." }),
    ]);
    expect(rolledBack.recaps).toEqual([
      expect.objectContaining({
        week: 3,
        subject: "Dest already wrote a different week 3 recap",
      }),
    ]);
    expect(rolledBack.settings.some((row) => row.key === "legacyMigratedFrom")).toBe(false);
    expect(rolledBack.settings).toEqual(
      expect.arrayContaining([
        { key: "legacyImportPending", value: "1" },
        { key: "legacyImportFailureCount", value: "1" },
      ]),
    );
  });

  it("accepts an exact field-for-field replay of already-copied rows and marks import complete", async () => {
    const sleeperId = "900000000000000097";
    const internalId = `legacy_${sleeperId}`;
    await seedLegacyBrain(sleeperId, { leagueId: sleeperId, sleeperLeagueId: sleeperId });
    const next = env.LEAGUE_BRAIN.getByName(internalId);
    await seedIdenticalLegacyHistory(next);
    await putLegacyImportPending(next);
    await instrumentLegacyExport(next);

    await next.bootstrap({
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(1);
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
      expect.arrayContaining([{ key: "legacyMigratedFrom", value: sleeperId }]),
    );
    expect(migrated.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
  });

  it("copies a seed-only source over a seed-only destination without losing source bible", async () => {
    const sleeperId = "900000000000000098";
    const internalId = `legacy_${sleeperId}`;
    const source = env.LEAGUE_BRAIN.getByName(sleeperId);
    await source.bootstrap({
      leagueId: sleeperId,
      sleeperLeagueId: sleeperId,
      name: "Legacy League",
      tone: "savage",
    });
    const sourceSql = await readBrainSql(source);
    expect(sourceSql.bible).toEqual([
      expect.objectContaining({ entry: "Legacy League is in the book. Tone: savage." }),
    ]);

    const next = env.LEAGUE_BRAIN.getByName(internalId);
    await seedExactBootstrapBible(next, "Cutman League", "playful");
    expect(await historicalRows(next)).toBe(false);
    await instrumentLegacyExport(next);

    await next.bootstrap({
      leagueId: internalId,
      sleeperLeagueId: sleeperId,
      name: "Cutman League",
      tone: "playful",
    });

    expect(await legacyExportCallCount(next)).toBe(1);
    const migrated = await readBrainSql(next);
    expect(migrated.snapshots).toEqual([]);
    expect(migrated.beats).toEqual([]);
    expect(migrated.recaps).toEqual([]);
    expect(migrated.bible).toEqual([
      expect.objectContaining({ entry: "Legacy League is in the book. Tone: savage." }),
    ]);
    expect(migrated.bible.some((row) => row.entry === "Cutman League is in the book. Tone: playful.")).toBe(
      false,
    );
    expect(migrated.settings).toEqual(
      expect.arrayContaining([{ key: "legacyMigratedFrom", value: sleeperId }]),
    );
    expect(migrated.settings.some((row) => row.key === "legacyImportPending")).toBe(false);
  });
});

describe("LeagueBrain persistTone", () => {
  type ToneBrain = {
    env: Env;
    persistTone: LeagueBrain["persistTone"];
    putSetting(key: string, value: string): void;
    bootstrap: LeagueBrain["bootstrap"];
    getDashboard: LeagueBrain["getDashboard"];
  };

  async function bootLeague(
    name: string,
    leagueId: string,
  ): Promise<{ stub: DurableObjectStub<LeagueBrain>; leagueId: string }> {
    await ensureSchema(env.DB);
    const league = await createLeague(env.DB, {
      id: leagueId,
      sleeperLeagueId: `sleeper-${leagueId}`,
      name: "Tone League",
      season: "2026",
      now: Date.now(),
    });
    await activateLeague(env.DB, league.id, Date.now() + 1);
    const stub = env.LEAGUE_BRAIN.getByName(name);
    await stub.bootstrap({
      leagueId: league.id,
      sleeperLeagueId: league.sleeper_league_id,
      name: league.name,
      tone: "playful",
    });
    return { stub, leagueId: league.id };
  }

  function interceptToneUpdates(
    db: D1Database,
    onToneUpdate: (run: () => ReturnType<D1PreparedStatement["run"]>) => Promise<void>,
  ): D1Database {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            const stmt = target.prepare(query);
            if (!query.includes("UPDATE leagues SET tone")) return stmt;
            return new Proxy(stmt, {
              get(stmtTarget, stmtProp, stmtReceiver) {
                if (stmtProp === "bind") {
                  return (...args: unknown[]) => {
                    const bound = (stmtTarget as D1PreparedStatement).bind(...args);
                    return new Proxy(bound, {
                      get(boundTarget, boundProp, boundReceiver) {
                        if (boundProp === "run") {
                          return async () => {
                            const run = () => (boundTarget as D1PreparedStatement).run();
                            await onToneUpdate(run);
                            return run();
                          };
                        }
                        const value = Reflect.get(boundTarget, boundProp, boundReceiver);
                        return typeof value === "function" ? value.bind(boundTarget) : value;
                      },
                    });
                  };
                }
                const value = Reflect.get(stmtTarget, stmtProp, stmtReceiver);
                return typeof value === "function" ? value.bind(stmtTarget) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async function withInterceptedToneDb<T>(
    stub: DurableObjectStub<LeagueBrain>,
    onToneUpdate: (run: () => ReturnType<D1PreparedStatement["run"]>) => Promise<void>,
    fn: (brain: ToneBrain) => Promise<T>,
  ): Promise<T> {
    return runInDurableObject(stub, async (instance) => {
      const brain = instance as unknown as ToneBrain;
      const originalDb = brain.env.DB;
      brain.env.DB = interceptToneUpdates(originalDb, onToneUpdate);
      try {
        return await fn(brain);
      } finally {
        brain.env.DB = originalDb;
      }
    });
  }

  it("writes the Durable Object setting and D1 together", async () => {
    const { stub, leagueId } = await bootLeague("tone-persist-ok", "lg_tone_persist_ok");
    await expect(stub.persistTone("savage")).resolves.toEqual({ ok: true });
    expect((await stub.getDashboard()).tone).toBe("savage");
    expect((await getLeague(env.DB, leagueId))?.tone).toBe("savage");
  });

  it("restores the prior Durable Object tone when D1 fails", async () => {
    const { stub, leagueId } = await bootLeague("tone-persist-rollback", "lg_tone_persist_rollback");
    const result = await withInterceptedToneDb(
      stub,
      async () => {
        throw new Error("simulated d1 tone write failure");
      },
      (brain) => brain.persistTone("savage"),
    );
    expect(result).toEqual({ ok: false, error: "save" });
    expect((await stub.getDashboard()).tone).toBe("playful");
    expect((await getLeague(env.DB, leagueId))?.tone).toBe("playful");
  });

  it("keeps the Durable Object tone when D1 commits then throws", async () => {
    const { stub, leagueId } = await bootLeague("tone-persist-commit-throw", "lg_tone_persist_commit_throw");
    const result = await withInterceptedToneDb(
      stub,
      async (run) => {
        await run();
        throw new Error("simulated d1 rpc throw after commit");
      },
      (brain) => brain.persistTone("savage"),
    );
    expect(result).toEqual({ ok: true });
    expect((await stub.getDashboard()).tone).toBe("savage");
    expect((await getLeague(env.DB, leagueId))?.tone).toBe("savage");
  });

  it("keeps a newer Durable Object tone written while D1 is in flight", async () => {
    const { stub, leagueId } = await bootLeague("tone-persist-bootstrap-race", "lg_tone_persist_bootstrap_race");
    let releaseFirstWrite!: () => void;
    let resolveFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      resolveFirstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    const result = await withInterceptedToneDb(
      stub,
      async () => {
        resolveFirstWriteStarted();
        await firstWriteGate;
        throw new Error("simulated d1 tone write failure");
      },
      async (brain) => {
        const pending = brain.persistTone("savage");
        await firstWriteStarted;
        expect((await brain.getDashboard()).tone).toBe("savage");

        await brain.bootstrap({
          leagueId,
          sleeperLeagueId: `sleeper-${leagueId}`,
          name: "Tone League",
          tone: "sportscenter",
        });
        expect((await brain.getDashboard()).tone).toBe("sportscenter");

        releaseFirstWrite();
        return pending;
      },
    );

    expect(result).toEqual({ ok: false, error: "save" });
    expect((await stub.getDashboard()).tone).toBe("sportscenter");
    expect((await getLeague(env.DB, leagueId))?.tone).toBe("playful");
  });

  it("returns desync when D1 fails and restoring the prior tone also fails", async () => {
    const { stub, leagueId } = await bootLeague("tone-persist-desync", "lg_tone_persist_desync");
    const result = await withInterceptedToneDb(
      stub,
      async () => {
        throw new Error("simulated d1 tone write failure");
      },
      async (brain) => {
        const originalPut = brain.putSetting.bind(brain);
        brain.putSetting = (key, value) => {
          if (key === "tone" && value === "playful") throw new Error("simulated storage rollback failure");
          originalPut(key, value);
        };
        return brain.persistTone("savage");
      },
    );
    expect(result).toEqual({ ok: false, error: "desync" });
    expect((await stub.getDashboard()).tone).toBe("savage");
    expect((await getLeague(env.DB, leagueId))?.tone).toBe("playful");
  });

  it("returns save when the object is not bootstrapped", async () => {
    const stub = env.LEAGUE_BRAIN.getByName("tone-persist-unbootstrapped");
    await expect(stub.persistTone("savage")).resolves.toEqual({ ok: false, error: "save" });
  });

  it("releases the mutation lock after a D1 failure so a later persist can succeed", async () => {
    const { stub, leagueId } = await bootLeague("tone-persist-lock-release", "lg_tone_persist_lock_release");
    const first = await withInterceptedToneDb(
      stub,
      async () => {
        throw new Error("simulated d1 tone write failure");
      },
      (brain) => brain.persistTone("savage"),
    );
    expect(first).toEqual({ ok: false, error: "save" });
    await expect(stub.persistTone("sportscenter")).resolves.toEqual({ ok: true });
    expect((await stub.getDashboard()).tone).toBe("sportscenter");
    expect((await getLeague(env.DB, leagueId))?.tone).toBe("sportscenter");
  });

  it("serializes overlapping persists so a failed older write cannot clobber a newer success", async () => {
    const { stub, leagueId } = await bootLeague("tone-persist-race", "lg_tone_persist_race");
    let toneWrites = 0;
    let releaseFirstWrite!: () => void;
    let resolveFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      resolveFirstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let resolveSecondWriteStarted!: () => void;
    const secondWriteStarted = new Promise<void>((resolve) => {
      resolveSecondWriteStarted = resolve;
    });

    const outcome = await withInterceptedToneDb(
      stub,
      async () => {
        toneWrites += 1;
        if (toneWrites === 1) {
          resolveFirstWriteStarted();
          await firstWriteGate;
          throw new Error("simulated d1 tone write failure");
        }
        resolveSecondWriteStarted();
      },
      async (brain) => {
        const older = brain.persistTone("savage");
        await firstWriteStarted;
        // Dashboard reads must not wait on the D1 write. If they shared the mutation
        // lock, this would deadlock until firstWriteGate is released.
        expect((await brain.getDashboard()).tone).toBe("savage");

        const newer = brain.persistTone("sportscenter");
        let secondReachedD1 = false;
        void secondWriteStarted.then(() => {
          secondReachedD1 = true;
        });
        // Drain queued microtasks so an unsynchronized persist would have entered D1.
        // The older write is still gated, so the newer persist must not reach D1 yet.
        for (let i = 0; i < 50; i += 1) await Promise.resolve();
        expect(secondReachedD1).toBe(false);
        expect(toneWrites).toBe(1);
        expect((await brain.getDashboard()).tone).toBe("savage");

        releaseFirstWrite();
        return Promise.all([older, newer]);
      },
    );

    expect(outcome).toEqual([
      { ok: false, error: "save" },
      { ok: true },
    ]);
    expect(toneWrites).toBe(2);
    expect((await stub.getDashboard()).tone).toBe("sportscenter");
    expect((await getLeague(env.DB, leagueId))?.tone).toBe("sportscenter");
  });
});
