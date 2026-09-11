import { DurableObject } from "cloudflare:workers";
import { generateBeat, generateRecap, type WorkersAi } from "@cutman/ai";
import { listRecapRecipients, setLeagueTone } from "@cutman/db";
import { recapEmail, sendEmail } from "@cutman/email";
import type { PlayerMap, SleeperMatchup } from "@cutman/sleeper";
import {
  beatPrompt,
  diffSnapshots,
  factsIfChanged,
  hashSnapshot,
  isTone,
  recapPrompt,
  runRecapAttempt,
  toneOrPlayful,
  type BeatDraft,
  type LeagueSnapshot,
  type RecapAttemptResult,
  type RecapDraft,
  type StoryFact,
  type Tone,
} from "@cutman/story";
import { getPlayerMap, sleeperFromEnv } from "./sleeper.ts";

const LEGACY_MIGRATED_FROM_KEY = "legacyMigratedFrom";
const LEGACY_IMPORT_PENDING_KEY = "legacyImportPending";
const LEGACY_IMPORT_FAILURE_COUNT_KEY = "legacyImportFailureCount";
const LEGACY_IMPORT_ABANDONED_KEY = "legacyImportAbandoned";

/** Consecutive rejected exports before the target brain gives up and starts a fresh book. */
export const LEGACY_IMPORT_MAX_ATTEMPTS = 3;

/** Thrown from readSettings while a legacy copy is unfinished so poll/recap/dashboard cannot seed a new history. */
export const LEGACY_IMPORT_PENDING_MESSAGE = "League history import is pending";

/** Thrown from readSettings when leagueId or sleeperLeagueId settings are missing. */
export const UNBOOTSTRAPPED_MESSAGE = "Cutman is not bootstrapped";

/** Thrown inside insertLegacyState when a PK already holds a different row. transactionSync rolls back. */
const LEGACY_IMPORT_CONFLICT_MESSAGE = "Legacy import conflict";

type LegacySqlValue = string | number | null;

function bootstrapBibleEntry(name: string, tone: Tone): string {
  return `${name} is in the book. Tone: ${tone}.`;
}

/** True only for the exact bootstrap seed of this object's stored name and tone. */
function isBootstrapBibleSeed(entry: string, name: string | null, tone: string | null): boolean {
  if (!name || !tone || !isTone(tone)) return false;
  return entry === bootstrapBibleEntry(name, tone);
}

type LegacyImportLogEvent = "league_brain.legacy_import_failed" | "league_brain.legacy_import_abandoned";
type LegacyImportFailureReason = "error" | "unknown";

type Settings = {
  leagueId: string;
  sleeperLeagueId: string;
  name: string;
  tone: Tone;
};

export type LegacyBrainState = {
  sleeperLeagueId: string;
  snapshots: Array<{
    id: number;
    week: number;
    payloadHash: string;
    payload: string;
    createdAt: number;
  }>;
  beats: Array<{
    id: number;
    kind: string;
    copy: string;
    facts: string;
    week: number;
    createdAt: number;
  }>;
  bible: Array<{ id: number; entry: string; createdAt: number }>;
  recaps: Array<{
    week: number;
    subject: string;
    body: string;
    facts: string;
    emailedAt: number | null;
    createdAt: number;
  }>;
};

export type Dashboard = {
  leagueId: string;
  sleeperLeagueId: string;
  name: string;
  tone: Tone;
  week: number | null;
  lastHash: string | null;
  bible: Array<{ id: number; entry: string; createdAt: number }>;
  timeline: Array<{ id: number; kind: string; copy: string; week: number; createdAt: number }>;
  recaps: Array<{ week: number; subject: string; body: string; createdAt: number }>;
};

export type PersistToneResult = { ok: true } | { ok: false; error: "save" | "desync" };

export class LeagueBrain extends DurableObject<Env> {
  // In-memory FIFO for persistTone only. Concurrent RPCs yield the input gate at the D1
  // await, so each mutation must finish (including rollback) before the next captures
  // prior tone. Hibernation drops this queue only when no request is in flight.
  private toneMutationMutex: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS beats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        copy TEXT NOT NULL,
        facts TEXT NOT NULL,
        week INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recaps (
        week INTEGER PRIMARY KEY,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        facts TEXT NOT NULL,
        emailed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bible (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // Pre-split brains stored the Sleeper snowflake as `leagueId` and had no `sleeperLeagueId`.
    // Copy only a numeric snowflake so generated internal ids are never treated as Sleeper ids.
    const leagueId = this.getSetting("leagueId");
    const sleeperLeagueId = this.getSetting("sleeperLeagueId");
    if (leagueId && !sleeperLeagueId && /^\d{6,}$/.test(leagueId)) {
      this.putSetting("sleeperLeagueId", leagueId);
    }
  }

  async bootstrap(input: { leagueId: string; sleeperLeagueId: string; name: string; tone: Tone }): Promise<void> {
    try {
      await this.importLegacyStateIfNeeded(input);
    } catch (error) {
      // Reason is only "error" | "unknown". Do not log name/message or league/Sleeper
      // ids: RPC / storage errors can embed Durable Object and Sleeper ids.
      this.recordLegacyImportRejection(error instanceof Error ? "error" : "unknown");
    }
    this.putSetting("leagueId", input.leagueId);
    this.putSetting("sleeperLeagueId", input.sleeperLeagueId);
    this.putSetting("name", input.name);
    this.putSetting("tone", input.tone);
    if (this.isLegacyImportPending()) return;
    const existing = this.ctx.storage.sql.exec("SELECT id FROM bible LIMIT 1").toArray();
    if (existing.length === 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO bible (entry, created_at) VALUES (?, ?)",
        bootstrapBibleEntry(input.name, input.tone),
        Date.now(),
      );
    }
  }

  /**
   * Read-only RPC used by the destination internal-id object during bootstrap.
   * Durable Object RPC is reachable only through this Worker's internal binding,
   * not as a public HTTP endpoint. The caller-id check is not cryptographic
   * authentication: it only refuses export when the destination is not the 0002
   * mapping (`legacy_${sleeperLeagueId}`) for this source. Combined with
   * `isLegacySourceFor`, unrelated internal objects cannot pull another league's
   * history.
   */
  async exportLegacyState(sleeperLeagueId: string, callerInternalLeagueId: string): Promise<LegacyBrainState | null> {
    if (callerInternalLeagueId !== `legacy_${sleeperLeagueId}`) return null;
    if (!this.isLegacySourceFor(sleeperLeagueId)) return null;
    return {
      sleeperLeagueId,
      snapshots: this.ctx.storage.sql
        .exec(
          "SELECT id, week, payload_hash AS payloadHash, payload, created_at AS createdAt FROM snapshots ORDER BY id",
        )
        .toArray() as LegacyBrainState["snapshots"],
      beats: this.ctx.storage.sql
        .exec("SELECT id, kind, copy, facts, week, created_at AS createdAt FROM beats ORDER BY id")
        .toArray() as LegacyBrainState["beats"],
      bible: this.ctx.storage.sql
        .exec("SELECT id, entry, created_at AS createdAt FROM bible ORDER BY id")
        .toArray() as LegacyBrainState["bible"],
      recaps: this.ctx.storage.sql
        .exec(
          "SELECT week, subject, body, facts, emailed_at AS emailedAt, created_at AS createdAt FROM recaps ORDER BY week",
        )
        .toArray() as LegacyBrainState["recaps"],
    };
  }

  async setTone(tone: Tone): Promise<void> {
    this.putSetting("tone", tone);
  }

  /**
   * Coordinator for commissioner tone changes: update this object's setting and D1
   * together. Dashboard reads stay off this queue so they can observe the live DO
   * tone while D1 is in flight. Do not wrap the D1 write in blockConcurrencyWhile —
   * that would stall poll/recap/dashboard for the network RTT.
   */
  async persistTone(tone: Tone): Promise<PersistToneResult> {
    return this.enqueueToneMutation(() => this.persistToneLocked(tone));
  }

  private enqueueToneMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.toneMutationMutex.then(work);
    this.toneMutationMutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persistToneLocked(tone: Tone): Promise<PersistToneResult> {
    let settings: Settings;
    try {
      settings = this.readSettings();
    } catch {
      return { ok: false, error: "save" };
    }
    const priorTone = settings.tone;
    try {
      this.putSetting("tone", tone);
    } catch {
      return { ok: false, error: "save" };
    }
    try {
      await setLeagueTone(this.env.DB, settings.leagueId, tone);
    } catch {
      try {
        this.putSetting("tone", priorTone);
      } catch {
        return { ok: false, error: "desync" };
      }
      return { ok: false, error: "save" };
    }
    return { ok: true };
  }

  async getDashboard(): Promise<Dashboard> {
    const settings = this.readSettings();
    const last = this.latestSnapshot();
    const bible = this.ctx.storage.sql
      .exec("SELECT id, entry, created_at AS createdAt FROM bible ORDER BY id DESC LIMIT 40")
      .toArray() as Array<{ id: number; entry: string; createdAt: number }>;
    const timeline = this.ctx.storage.sql
      .exec("SELECT id, kind, copy, week, created_at AS createdAt FROM beats ORDER BY id DESC LIMIT 50")
      .toArray() as Array<{ id: number; kind: string; copy: string; week: number; createdAt: number }>;
    const recaps = this.ctx.storage.sql
      .exec("SELECT week, subject, body, created_at AS createdAt FROM recaps ORDER BY week DESC")
      .toArray() as Array<{ week: number; subject: string; body: string; createdAt: number }>;
    return {
      leagueId: settings.leagueId,
      sleeperLeagueId: settings.sleeperLeagueId,
      name: settings.name,
      tone: settings.tone,
      week: last?.week ?? null,
      lastHash: last?.hash ?? null,
      bible,
      timeline,
      recaps,
    };
  }

  async poll(): Promise<{ wroteBeat: boolean; hash: string; facts: number }> {
    const settings = this.readSettings();
    const sleeper = sleeperFromEnv(this.env);
    const state = await sleeper.getNflState();
    const [users, rosters, matchups, transactions, players] = await Promise.all([
      sleeper.getLeagueUsers(settings.sleeperLeagueId),
      sleeper.getRosters(settings.sleeperLeagueId),
      sleeper.getMatchups(settings.sleeperLeagueId, state.week),
      sleeper.getTransactions(settings.sleeperLeagueId, state.week),
      getPlayerMap(this.env, sleeper),
    ]);
    const snapshot: LeagueSnapshot = {
      leagueId: settings.leagueId,
      week: state.week,
      users,
      rosters,
      matchups,
      transactions,
    };
    return this.ingestSnapshot(snapshot, players);
  }

  async ingestSnapshot(snapshot: LeagueSnapshot, players: PlayerMap = {}): Promise<{ wroteBeat: boolean; hash: string; facts: number }> {
    this.assertLegacyImportReady();
    const hash = await hashSnapshot(snapshot);
    const last = this.latestSnapshot();
    const facts = await factsIfChanged(last?.hash ?? null, hash, last?.snapshot ?? null, snapshot, players);
    this.ctx.storage.sql.exec(
      "INSERT INTO snapshots (week, payload_hash, payload, created_at) VALUES (?, ?, ?, ?)",
      snapshot.week,
      hash,
      JSON.stringify(snapshot),
      Date.now(),
    );
    if (facts.length === 0) {
      return { wroteBeat: false, hash, facts: 0 };
    }
    const wroteBeat = await this.publishBeat(snapshot.week, facts);
    return { wroteBeat, hash, facts: facts.length };
  }

  async attemptRecap(): Promise<RecapAttemptResult> {
    const last = this.latestSnapshot();
    const matchups = last?.snapshot.matchups ?? [];
    const facts = last
      ? diffSnapshots(null, last.snapshot)
      : [];
    return this.attemptRecapWithGenerator(matchups, facts, async (storyFacts) => {
      const settings = this.readSettings();
      const prompt = recapPrompt({
        tone: settings.tone,
        leagueName: settings.name,
        week: last?.week ?? 0,
        bible: this.bibleLines(),
        facts: storyFacts,
      });
      return generateRecap(this.env.AI as WorkersAi, prompt.system, prompt.user);
    });
  }

  async attemptRecapWithGenerator(
    matchups: SleeperMatchup[],
    facts: StoryFact[],
    generate: (facts: StoryFact[]) => Promise<RecapDraft>,
  ): Promise<RecapAttemptResult> {
    const last = this.latestSnapshot();
    const week = last?.week ?? 0;
    const existingRow =
      (this.ctx.storage.sql.exec("SELECT subject, body FROM recaps WHERE week = ?", week).toArray()[0] as
        | { subject: string; body: string }
        | undefined) ?? null;
    const settings = this.readSettings();
    return runRecapAttempt({
      week,
      matchups,
      existingRecap: existingRow,
      facts,
      generate,
      archive: async (recap) => {
        this.ctx.storage.sql.exec(
          "INSERT INTO recaps (week, subject, body, facts, emailed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          week,
          recap.subject,
          recap.body,
          JSON.stringify(facts),
          Date.now(),
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO bible (entry, created_at) VALUES (?, ?)",
          `Week ${week} recap: ${recap.subject}`,
          Date.now(),
        );
      },
      email: async (recap) => {
        try {
          const recipients = await listRecapRecipients(this.env.DB, settings.leagueId);
          if (recipients.length === 0) return;
          const message = recapEmail(recap);
          await Promise.all(
            recipients.map((recipient) =>
              sendEmail(this.env.EMAIL, {
                from: this.env.EMAIL_FROM,
                to: recipient.email,
                subject: message.subject,
                text: message.text,
              }),
            ),
          );
        } catch (error) {
          console.error("recap email failed after archive", error);
        }
      },
    });
  }

  async listRecaps(): Promise<Array<{ week: number; subject: string; body: string }>> {
    return this.ctx.storage.sql.exec("SELECT week, subject, body FROM recaps ORDER BY week").toArray() as Array<{
      week: number;
      subject: string;
      body: string;
    }>;
  }

  async listBeats(): Promise<Array<{ copy: string; week: number }>> {
    return this.ctx.storage.sql.exec("SELECT copy, week FROM beats ORDER BY id").toArray() as Array<{
      copy: string;
      week: number;
    }>;
  }

  private async publishBeat(week: number, facts: StoryFact[]): Promise<boolean> {
    const settings = this.readSettings();
    let draft: BeatDraft;
    try {
      const prompt = beatPrompt({
        tone: settings.tone,
        leagueName: settings.name,
        week,
        bible: this.bibleLines(),
        facts,
      });
      draft = await generateBeat(this.env.AI as WorkersAi, prompt.system, prompt.user);
    } catch {
      return false;
    }
    if (!draft.copy.trim()) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO beats (kind, copy, facts, week, created_at) VALUES (?, ?, ?, ?, ?)",
      facts[0]?.kind ?? "scoreboard",
      draft.copy,
      JSON.stringify(facts),
      week,
      Date.now(),
    );
    for (const fact of facts.filter((entry) => entry.kind === "trade" || entry.kind === "rivalry")) {
      this.ctx.storage.sql.exec("INSERT INTO bible (entry, created_at) VALUES (?, ?)", fact.copy, Date.now());
    }
    return true;
  }

  private bibleLines(): string[] {
    return (
      this.ctx.storage.sql.exec("SELECT entry FROM bible ORDER BY id DESC LIMIT 20").toArray() as Array<{ entry: string }>
    ).map((row) => row.entry);
  }

  private latestSnapshot(): { hash: string; week: number; snapshot: LeagueSnapshot } | null {
    const row = this.ctx.storage.sql
      .exec("SELECT payload_hash AS hash, week, payload FROM snapshots ORDER BY id DESC LIMIT 1")
      .toArray()[0] as { hash: string; week: number; payload: string } | undefined;
    if (!row) return null;
    return { hash: row.hash, week: row.week, snapshot: JSON.parse(row.payload) as LeagueSnapshot };
  }

  private readSettings(): Settings {
    this.assertLegacyImportReady();
    const leagueId = this.getSetting("leagueId");
    const sleeperLeagueId = this.getSetting("sleeperLeagueId");
    const name = this.getSetting("name") ?? "Example League";
    const tone = toneOrPlayful(this.getSetting("tone"));
    if (!leagueId || !sleeperLeagueId) throw new Error(UNBOOTSTRAPPED_MESSAGE);
    return { leagueId, sleeperLeagueId, name, tone };
  }

  private getSetting(key: string): string | null {
    const row = this.ctx.storage.sql.exec("SELECT value FROM settings WHERE key = ?", key).toArray()[0] as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private async importLegacyStateIfNeeded(input: {
    leagueId: string;
    sleeperLeagueId: string;
  }): Promise<void> {
    if (this.getSetting(LEGACY_MIGRATED_FROM_KEY)) {
      this.ctx.storage.transactionSync(() => this.clearLegacyImportInFlight());
      return;
    }

    // Abandoned means we already gave up on the source. Do not retry the export,
    // and do not write legacyMigratedFrom — that marker would claim a copy we never made.
    if (this.getSetting(LEGACY_IMPORT_ABANDONED_KEY)) {
      this.deleteSetting(LEGACY_IMPORT_PENDING_KEY);
      return;
    }

    const legacyId = this.env.LEAGUE_BRAIN.idFromName(input.sleeperLeagueId);
    if (legacyId.equals(this.ctx.id) || input.leagueId === input.sleeperLeagueId) {
      this.ctx.storage.transactionSync(() => this.markLegacyImportComplete(input.sleeperLeagueId));
      return;
    }

    // Only the 0002 mapping (`legacy_${sleeperLeagueId}`) may pull from the
    // Sleeper-named source. Any other fresh internal ID skips that RPC and
    // marks the copy complete so onboarding brains never sit pending.
    if (input.leagueId !== `legacy_${input.sleeperLeagueId}`) {
      this.ctx.storage.transactionSync(() => this.markLegacyImportComplete(input.sleeperLeagueId));
      return;
    }

    // Already-initialized non-empty targets keep their rows. Bootstrap bible seed
    // alone is not history: a seed-only object must still export from the source.
    // A pending import with no history must retry; pending + existing rows still
    // copy so a rejected export cannot be closed out by poll data. Each copied row
    // must be newly inserted or proven identical; a differing PK rolls the copy back.
    if (!this.isLegacyImportPending() && this.hasHistoricalRows()) {
      this.ctx.storage.transactionSync(() => this.markLegacyImportComplete(input.sleeperLeagueId));
      return;
    }

    const legacy = await this.exportLegacyStateFromSource(input.sleeperLeagueId, input.leagueId);
    // The export await yields the DO input gate. Re-read completion markers before
    // writing so a concurrent bootstrap cannot look "done" with a partial copy.
    if (this.getSetting(LEGACY_MIGRATED_FROM_KEY)) {
      this.ctx.storage.transactionSync(() => this.clearLegacyImportInFlight());
      return;
    }
    if (this.getSetting(LEGACY_IMPORT_ABANDONED_KEY)) return;
    if (!this.isLegacyImportPending() && this.hasHistoricalRows()) {
      this.ctx.storage.transactionSync(() => this.markLegacyImportComplete(input.sleeperLeagueId));
      return;
    }

    // SqlStorage has no BEGIN/COMMIT. transactionSync batches the copy; a throw
    // rolls it back and the next bootstrap retries. Completion clears pending /
    // failure count in the same transaction so a partial copy cannot look "done".
    this.ctx.storage.transactionSync(() => {
      if (legacy) this.insertLegacyState(legacy);
      this.markLegacyImportComplete(input.sleeperLeagueId);
    });
  }

  /** Test seam: replace on the instance to simulate a rejected export RPC. */
  private async exportLegacyStateFromSource(
    sleeperLeagueId: string,
    callerInternalLeagueId: string,
  ): Promise<LegacyBrainState | null> {
    return this.env.LEAGUE_BRAIN.getByName(sleeperLeagueId).exportLegacyState(sleeperLeagueId, callerInternalLeagueId);
  }

  private isLegacyImportPending(): boolean {
    return this.getSetting(LEGACY_IMPORT_PENDING_KEY) !== null;
  }

  private assertLegacyImportReady(): void {
    if (this.isLegacyImportPending()) throw new Error(LEGACY_IMPORT_PENDING_MESSAGE);
  }

  private legacyImportFailureCount(): number {
    const raw = this.getSetting(LEGACY_IMPORT_FAILURE_COUNT_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  /**
   * Increment the consecutive-failure counter in one synchronous transaction so a
   * concurrent waiter at the export await cannot observe a half-updated pending/abandoned pair.
   * Skip if a sibling request already completed or abandoned the copy.
   */
  private recordLegacyImportRejection(reason: LegacyImportFailureReason): void {
    let attempt = 0;
    this.ctx.storage.transactionSync(() => {
      if (this.getSetting(LEGACY_MIGRATED_FROM_KEY) || this.getSetting(LEGACY_IMPORT_ABANDONED_KEY)) {
        return;
      }
      attempt = this.legacyImportFailureCount() + 1;
      this.putSetting(LEGACY_IMPORT_FAILURE_COUNT_KEY, String(attempt));
      if (attempt >= LEGACY_IMPORT_MAX_ATTEMPTS) {
        this.deleteSetting(LEGACY_IMPORT_PENDING_KEY);
        this.putSetting(LEGACY_IMPORT_ABANDONED_KEY, "1");
      } else {
        this.putSetting(LEGACY_IMPORT_PENDING_KEY, "1");
      }
    });
    if (attempt === 0) return;
    this.logLegacyImportEvent("league_brain.legacy_import_failed", attempt, reason);
    if (attempt >= LEGACY_IMPORT_MAX_ATTEMPTS) {
      this.logLegacyImportEvent("league_brain.legacy_import_abandoned", attempt, reason);
    }
  }

  private logLegacyImportEvent(
    event: LegacyImportLogEvent,
    attempt: number,
    reason: LegacyImportFailureReason,
  ): void {
    // Omit leagueId and Sleeper snowflakes. Operators get event, attempt, max, and a bounded reason only.
    const payload = JSON.stringify({
      event,
      attempt,
      max: LEGACY_IMPORT_MAX_ATTEMPTS,
      reason,
    });
    switch (event) {
      case "league_brain.legacy_import_failed":
        console.error(payload);
        return;
      case "league_brain.legacy_import_abandoned":
        console.warn(payload);
        return;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private clearLegacyImportInFlight(): void {
    this.deleteSetting(LEGACY_IMPORT_PENDING_KEY);
    this.deleteSetting(LEGACY_IMPORT_FAILURE_COUNT_KEY);
    this.deleteSetting(LEGACY_IMPORT_ABANDONED_KEY);
  }

  private markLegacyImportComplete(sleeperLeagueId: string): void {
    this.putSetting(LEGACY_MIGRATED_FROM_KEY, sleeperLeagueId);
    this.clearLegacyImportInFlight();
  }

  private deleteSetting(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM settings WHERE key = ?", key);
  }

  private isLegacySourceFor(sleeperLeagueId: string): boolean {
    const leagueId = this.getSetting("leagueId");
    const storedSleeper = this.getSetting("sleeperLeagueId");
    const identity = storedSleeper ?? leagueId;
    if (!identity || identity !== sleeperLeagueId) return false;
    // Pre-onboarding brains stored the snowflake as leagueId. Split-identity
    // objects (internal leagueId + Sleeper id) must not export for reverse-copy.
    return leagueId === sleeperLeagueId;
  }

  private hasHistoricalRows(): boolean {
    const snapshot = this.ctx.storage.sql.exec("SELECT id FROM snapshots LIMIT 1").toArray();
    if (snapshot.length > 0) return true;
    const beat = this.ctx.storage.sql.exec("SELECT id FROM beats LIMIT 1").toArray();
    if (beat.length > 0) return true;
    const recap = this.ctx.storage.sql.exec("SELECT week FROM recaps LIMIT 1").toArray();
    if (recap.length > 0) return true;
    const bible = this.ctx.storage.sql.exec("SELECT entry FROM bible").toArray() as Array<{ entry: string }>;
    const name = this.getSetting("name");
    const tone = this.getSetting("tone");
    return bible.some((row) => !isBootstrapBibleSeed(row.entry, name, tone));
  }

  /**
   * Drop this object's exact bootstrap bible placeholder before copying source
   * rows. Destination seed is typically id=1 and would otherwise collide with a
   * source seed or first bible entry; INSERT OR IGNORE would keep the placeholder
   * and lose source history. The delete is in the same transaction as the copy.
   */
  private removeDestinationBootstrapBibleSeed(): void {
    const name = this.getSetting("name");
    const tone = this.getSetting("tone");
    if (!name || !tone || !isTone(tone)) return;
    this.ctx.storage.sql.exec("DELETE FROM bible WHERE entry = ?", bootstrapBibleEntry(name, tone));
  }

  /**
   * INSERT OR IGNORE, then require completeness: SqlStorageCursor.rowsWritten > 0
   * means a new row; otherwise the conflicting PK must exist and match field-for-field
   * (idempotent replay). Drain the cursor first — rowsWritten is billing metadata
   * that may increase until the statement is fully consumed. A missing or differing
   * conflict throws so transactionSync rolls back and markLegacyImportComplete is skipped.
   */
  private insertLegacyRowOrIdentical(
    insertSql: string,
    insertBindings: LegacySqlValue[],
    selectSql: string,
    selectBindings: LegacySqlValue[],
    expected: Record<string, LegacySqlValue>,
  ): void {
    const cursor = this.ctx.storage.sql.exec(insertSql, ...insertBindings);
    cursor.toArray();
    if (cursor.rowsWritten > 0) return;
    const existing = this.ctx.storage.sql.exec(selectSql, ...selectBindings).toArray()[0] as
      | Record<string, LegacySqlValue>
      | undefined;
    if (!existing) throw new Error(LEGACY_IMPORT_CONFLICT_MESSAGE);
    for (const [key, value] of Object.entries(expected)) {
      if (existing[key] !== value) throw new Error(LEGACY_IMPORT_CONFLICT_MESSAGE);
    }
  }

  private insertLegacyState(legacy: LegacyBrainState): void {
    this.removeDestinationBootstrapBibleSeed();
    for (const row of legacy.snapshots) {
      this.insertLegacyRowOrIdentical(
        "INSERT OR IGNORE INTO snapshots (id, week, payload_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        [row.id, row.week, row.payloadHash, row.payload, row.createdAt],
        "SELECT id, week, payload_hash AS payloadHash, payload, created_at AS createdAt FROM snapshots WHERE id = ?",
        [row.id],
        {
          id: row.id,
          week: row.week,
          payloadHash: row.payloadHash,
          payload: row.payload,
          createdAt: row.createdAt,
        },
      );
    }
    for (const row of legacy.beats) {
      this.insertLegacyRowOrIdentical(
        "INSERT OR IGNORE INTO beats (id, kind, copy, facts, week, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [row.id, row.kind, row.copy, row.facts, row.week, row.createdAt],
        "SELECT id, kind, copy, facts, week, created_at AS createdAt FROM beats WHERE id = ?",
        [row.id],
        {
          id: row.id,
          kind: row.kind,
          copy: row.copy,
          facts: row.facts,
          week: row.week,
          createdAt: row.createdAt,
        },
      );
    }
    for (const row of legacy.bible) {
      this.insertLegacyRowOrIdentical(
        "INSERT OR IGNORE INTO bible (id, entry, created_at) VALUES (?, ?, ?)",
        [row.id, row.entry, row.createdAt],
        "SELECT id, entry, created_at AS createdAt FROM bible WHERE id = ?",
        [row.id],
        { id: row.id, entry: row.entry, createdAt: row.createdAt },
      );
    }
    for (const row of legacy.recaps) {
      this.insertLegacyRowOrIdentical(
        "INSERT OR IGNORE INTO recaps (week, subject, body, facts, emailed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [row.week, row.subject, row.body, row.facts, row.emailedAt, row.createdAt],
        "SELECT week, subject, body, facts, emailed_at AS emailedAt, created_at AS createdAt FROM recaps WHERE week = ?",
        [row.week],
        {
          week: row.week,
          subject: row.subject,
          body: row.body,
          facts: row.facts,
          emailedAt: row.emailedAt,
          createdAt: row.createdAt,
        },
      );
    }
  }

  private putSetting(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}
