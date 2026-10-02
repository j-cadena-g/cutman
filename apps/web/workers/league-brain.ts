import { DurableObject } from "cloudflare:workers";
import { generateBeat, generateRecap, type WorkersAi } from "@cutman/ai";
import { getLeague, listRecapRecipients, setLeagueTone } from "@cutman/db";
import { recapEmail, sendEmail } from "@cutman/email";
import type {
  NflState,
  PlayerMap,
  SleeperLeague,
  SleeperMatchup,
  SleeperTransaction,
} from "@cutman/sleeper";
import {
  beatPrompt,
  buildSeasonLedger,
  canRecapCurrentWeek,
  closeGameEntries,
  diffSnapshots,
  easternParts,
  factsIfChanged,
  hashSnapshot,
  isBlankBeat,
  isPlayedWeek,
  isTone,
  lastSettledWeek,
  previouslyOnEntry,
  recapPrompt,
  runRecapAttempt,
  seasonLines,
  selectRecapWeek,
  toneOrPlayful,
  type BeatDraft,
  type FinalWeek,
  type LeagueSnapshot,
  type RecapAttemptResult,
  type RecapDraft,
  type SeasonFocus,
  type SeasonLabels,
  type SeasonRules,
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

/**
 * Failed sends to one recipient before that recipient is dropped from a recap. Retries run
 * hourly, so this is about a day: long enough to ride out an email outage, short enough that
 * one bad address does not hold every later recap.
 */
export const MAX_RECAP_DELIVERY_FAILURES = 24;

/** Thrown from readSettings while a legacy copy is unfinished so poll/recap/dashboard cannot seed a new history. */
export const LEGACY_IMPORT_PENDING_MESSAGE = "League history import is pending";

/** Thrown from readSettings when leagueId or sleeperLeagueId settings are missing. */
export const UNBOOTSTRAPPED_MESSAGE = "Cutman is not bootstrapped";

/** Thrown inside insertLegacyState when a PK already holds a different row. transactionSync rolls back. */
const LEGACY_IMPORT_CONFLICT_MESSAGE = "Legacy import conflict";

type LegacySqlValue = string | number | null;

const PLAYOFF_WEEK_START_KEY = "playoffWeekStart";
const START_WEEK_KEY = "startWeek";
const MEDIAN_WINS_KEY = "medianWins";
/** "1" when the latest stored snapshot's week was already final. Bench-shame dedupe needs it. */
const LATEST_SNAPSHOT_SETTLED_KEY = "latestSnapshotSettled";

/** Keep what the ledger reads: the score, the pairing, and starters' points. */
function trimFinalMatchup(matchup: SleeperMatchup): SleeperMatchup {
  const starters = matchup.starters ?? [];
  const table = matchup.players_points ?? {};
  return {
    roster_id: matchup.roster_id,
    matchup_id: matchup.matchup_id,
    points: matchup.points,
    starters,
    players_points: Object.fromEntries(
      starters.filter((id) => typeof table[id] === "number").map((id) => [id, table[id] as number]),
    ),
  };
}

function positiveWeek(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function bootstrapBibleEntry(name: string, tone: Tone): string {
  return `${name} is in the book. Tone: ${tone}.`;
}

function isBrainGateError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === UNBOOTSTRAPPED_MESSAGE || error.message === LEGACY_IMPORT_PENDING_MESSAGE)
  );
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
  // Optional: during a gradual deploy the source can still run code that predates these tables.
  recapDeliveries?: Array<{ week: number; email: string; sentAt: number }>;
  recapDeliveryFailures?: Array<{ week: number; email: string; failures: number }>;
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
  // In-flight recap attempt and delivery per week. See attemptRecapWithGenerator and deliverRecap.
  private readonly recapAttempts = new Map<number, Promise<RecapAttemptResult>>();
  private readonly recapDeliveries = new Map<number, Promise<void>>();

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
      CREATE TABLE IF NOT EXISTS recap_deliveries (
        week INTEGER NOT NULL,
        email TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (week, email)
      );
      CREATE TABLE IF NOT EXISTS recap_delivery_failures (
        week INTEGER NOT NULL,
        email TEXT NOT NULL,
        failures INTEGER NOT NULL,
        PRIMARY KEY (week, email)
      );
      CREATE TABLE IF NOT EXISTS bible (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS final_weeks (
        week INTEGER PRIMARY KEY,
        played INTEGER NOT NULL,
        matchups TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
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
      recapDeliveries: this.ctx.storage.sql
        .exec("SELECT week, email, sent_at AS sentAt FROM recap_deliveries ORDER BY week, email")
        .toArray() as NonNullable<LegacyBrainState["recapDeliveries"]>,
      recapDeliveryFailures: this.ctx.storage.sql
        .exec("SELECT week, email, failures FROM recap_delivery_failures ORDER BY week, email")
        .toArray() as NonNullable<LegacyBrainState["recapDeliveryFailures"]>,
    };
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
    const priorStoredTone = this.getSetting("tone");
    try {
      this.putSetting("tone", tone);
    } catch {
      return { ok: false, error: "save" };
    }
    try {
      await setLeagueTone(this.env.DB, settings.leagueId, tone);
    } catch {
      // Workers RPC can throw after D1 committed. Confirm before rolling the DO back.
      let persisted: string | null | undefined;
      try {
        persisted = (await getLeague(this.env.DB, settings.leagueId))?.tone ?? null;
      } catch {
        persisted = undefined;
      }
      if (persisted === tone) {
        return { ok: true };
      }
      try {
        if (this.getSetting("tone") === tone) {
          if (priorStoredTone === null) {
            this.deleteSetting("tone");
          } else {
            this.putSetting("tone", priorStoredTone);
          }
        }
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

  async poll(now: number = Date.now()): Promise<{ wroteBeat: boolean; hash: string; facts: number }> {
    const settings = this.readSettings();
    const sleeper = sleeperFromEnv(this.env);
    const state = await this.loadNflState();
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
    // Settle finished weeks first so the beat below sees the season through last week.
    await this.syncFinalWeeksQuietly(state, matchups, { users, rosters, players }, now);
    return this.ingestSnapshot(snapshot, players);
  }

  private async syncFinalWeeksQuietly(
    state: NflState,
    currentMatchups: SleeperMatchup[],
    labels: SeasonLabels,
    now: number,
  ): Promise<void> {
    try {
      await this.syncFinalWeeks(state, currentMatchups, labels, now);
    } catch (error) {
      if (isBrainGateError(error)) throw error;
      // The ledger catches up on the next poll. Omit ids and messages: Sleeper errors embed paths.
      console.error(
        JSON.stringify({ event: "league_brain.final_weeks_sync_failed", reason: error instanceof Error ? "error" : "unknown" }),
      );
    }
  }

  /**
   * Record every settled week the ledger is missing, and refresh the latest one for stat
   * corrections. A league set up mid-season backfills its earlier weeks here on the first poll.
   */
  private async syncFinalWeeks(
    state: NflState,
    currentMatchups: SleeperMatchup[],
    labels: SeasonLabels,
    now: number,
  ): Promise<void> {
    const settings = this.readSettings();
    const league = await this.loadLeague(settings.sleeperLeagueId);
    if (league) this.storeLeagueRules(league);
    const settled = lastSettledWeek({
      seasonType: state.season_type,
      nflWeek: state.week,
      currentWeekPlayed: isPlayedWeek(currentMatchups),
      canSettleCurrent: canRecapCurrentWeek(easternParts(new Date(now))),
    });
    const startWeek = positiveWeek(Number(this.getSetting(START_WEEK_KEY))) ?? 1;
    if (settled < startWeek) return;

    const recorded = new Set(
      (this.ctx.storage.sql.exec("SELECT week FROM final_weeks").toArray() as Array<{ week: number }>).map(
        (row) => row.week,
      ),
    );
    const hadPlayedWeeks = this.readFinalWeeks().length > 0;
    const wanted: number[] = [];
    for (let week = startWeek; week <= settled; week += 1) {
      if (!recorded.has(week) || week === settled) wanted.push(week);
    }
    // Fetch in parallel to stay inside the provisioning deadline, but keep every week that
    // loaded: one failed week must not throw away the rest.
    const loaded = await Promise.allSettled(
      wanted.map(async (week) => ({
        week,
        matchups: week === state.week ? currentMatchups : await this.loadWeekMatchups(settings.sleeperLeagueId, week),
      })),
    );
    const newlySettled: FinalWeek[] = [];
    for (const result of loaded) {
      if (result.status !== "fulfilled") continue;
      const { week, matchups } = result.value;
      if (this.recordFinalWeek(week, matchups, now)) newlySettled.push({ week, matchups });
    }

    if (!hadPlayedWeeks) {
      const weeks = this.readFinalWeeks();
      const entry = weeks.length >= 2 ? previouslyOnEntry(buildSeasonLedger(weeks, this.seasonRules()), labels) : null;
      if (entry) this.insertBibleIfNew(entry, now);
    }
    for (const week of newlySettled.sort((left, right) => left.week - right.week)) {
      this.writeCloseGames(week, labels, now);
    }

    const failure = loaded.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  /** One-score finals go in the bible once, from final scores, when their week first settles. */
  private writeCloseGames(week: FinalWeek, labels: SeasonLabels, now = Date.now()): void {
    for (const entry of closeGameEntries(week, labels)) this.insertBibleIfNew(entry, now);
  }

  /**
   * Upsert one week. An empty response is a Sleeper hiccup and is skipped; a played week is
   * never downgraded to unplayed. Returns true only when the week has just become played.
   */
  private recordFinalWeek(week: number, matchups: SleeperMatchup[], now = Date.now()): boolean {
    if (matchups.length === 0) return false;
    const played = isPlayedWeek(matchups) ? 1 : 0;
    const wasPlayed = this.isSettledWeek(week);
    this.ctx.storage.sql.exec(
      `INSERT INTO final_weeks (week, played, matchups, recorded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(week) DO UPDATE SET played = excluded.played, matchups = excluded.matchups, recorded_at = excluded.recorded_at
       WHERE (final_weeks.matchups != excluded.matchups OR final_weeks.played != excluded.played)
         AND NOT (final_weeks.played = 1 AND excluded.played = 0)`,
      week,
      played,
      JSON.stringify(matchups.map(trimFinalMatchup)),
      now,
    );
    return played === 1 && !wasPlayed;
  }

  private readFinalWeeks(): FinalWeek[] {
    return (
      this.ctx.storage.sql
        .exec("SELECT week, matchups FROM final_weeks WHERE played = 1 ORDER BY week")
        .toArray() as Array<{ week: number; matchups: string }>
    ).map((row) => ({ week: row.week, matchups: JSON.parse(row.matchups) as SleeperMatchup[] }));
  }

  private storeLeagueRules(league: SleeperLeague): void {
    const settings = league.settings ?? {};
    const playoffWeekStart = positiveWeek(settings.playoff_week_start);
    const startWeek = positiveWeek(settings.start_week);
    if (playoffWeekStart) this.putSetting(PLAYOFF_WEEK_START_KEY, String(playoffWeekStart));
    if (startWeek) this.putSetting(START_WEEK_KEY, String(startWeek));
    this.putSetting(MEDIAN_WINS_KEY, settings.league_average_match === 1 ? "1" : "0");
  }

  private seasonRules(): SeasonRules {
    return {
      playoffWeekStart: positiveWeek(Number(this.getSetting(PLAYOFF_WEEK_START_KEY))),
      medianWins: this.getSetting(MEDIAN_WINS_KEY) === "1",
    };
  }

  private seasonContext(labels: SeasonLabels, focus: SeasonFocus): string[] {
    // Never let a later settled week leak into the context for an earlier beat or recap.
    const weeks = this.readFinalWeeks().filter((week) => week.week <= focus.week);
    return seasonLines(buildSeasonLedger(weeks, this.seasonRules()), labels, focus);
  }

  async ingestSnapshot(snapshot: LeagueSnapshot, players: PlayerMap = {}): Promise<{ wroteBeat: boolean; hash: string; facts: number }> {
    this.assertLegacyImportReady();
    const hash = await hashSnapshot(snapshot);
    const last = this.latestSnapshot();
    const settled = this.isSettledWeek(snapshot.week);
    const prevSettled = last?.week === snapshot.week && this.getSetting(LATEST_SNAPSHOT_SETTLED_KEY) === "1";
    const facts = await factsIfChanged(last?.hash ?? null, hash, last?.snapshot ?? null, snapshot, players, {
      settled,
      prevSettled,
    });
    if (facts.length === 0) {
      this.insertSnapshot(snapshot, hash, settled);
      return { wroteBeat: false, hash, facts: 0 };
    }
    const season = this.seasonContext(
      { users: snapshot.users, rosters: snapshot.rosters, players },
      { week: snapshot.week, matchups: snapshot.matchups, settled },
    );
    let draft: BeatDraft;
    try {
      draft = await this.generateBeatDraft(snapshot.week, facts, season);
    } catch (error) {
      if (isBrainGateError(error)) throw error;
      return { wroteBeat: false, hash, facts: facts.length };
    }
    if (isBlankBeat(draft)) {
      return { wroteBeat: false, hash, facts: facts.length };
    }
    const wroteBeat = this.publishBeat(snapshot, hash, facts, draft, last?.hash ?? null, settled);
    return { wroteBeat, hash, facts: facts.length };
  }

  private isSettledWeek(week: number): boolean {
    return this.ctx.storage.sql.exec("SELECT week FROM final_weeks WHERE week = ? AND played = 1", week).toArray().length > 0;
  }

  /** Test seam. Default calls Gemma. A throw or blank copy writes nothing. */
  private async generateBeatDraft(week: number, facts: StoryFact[], season: string[] = []): Promise<BeatDraft> {
    const settings = this.readSettings();
    const prompt = beatPrompt({
      tone: settings.tone,
      leagueName: settings.name,
      week,
      bible: this.bibleLines(),
      season,
      facts,
    });
    return generateBeat(this.env.AI as WorkersAi, prompt.system, prompt.user);
  }

  /** Test seam. Default calls Gemma for the recap prompt the caller already built. */
  private async generateRecapDraft(prompt: { system: string; user: string }): Promise<RecapDraft> {
    return generateRecap(this.env.AI as WorkersAi, prompt.system, prompt.user);
  }

  /** Test seam. Fixtures ignore the week argument, so tests return matchups per week. */
  private async loadRecapWeek(
    sleeperLeagueId: string,
    week: number,
  ): Promise<{ matchups: SleeperMatchup[]; transactions: SleeperTransaction[] }> {
    const sleeper = sleeperFromEnv(this.env);
    const [matchups, transactions] = await Promise.all([
      sleeper.getMatchups(sleeperLeagueId, week),
      sleeper.getTransactions(sleeperLeagueId, week),
    ]);
    return { matchups, transactions };
  }

  /** Test seam. Fixtures ignore the week argument, so backfill tests return matchups per week. */
  private async loadWeekMatchups(sleeperLeagueId: string, week: number): Promise<SleeperMatchup[]> {
    return sleeperFromEnv(this.env).getMatchups(sleeperLeagueId, week);
  }

  /** Test seam. League settings carry the playoff start and median scoring. */
  private async loadLeague(sleeperLeagueId: string): Promise<SleeperLeague | null> {
    return sleeperFromEnv(this.env).getLeague(sleeperLeagueId);
  }

  /** Test seam. Fixture NFL state is pinned to week 1, so rollover tests replace this. */
  private async loadNflState(): Promise<NflState> {
    return sleeperFromEnv(this.env).getNflState();
  }

  async attemptRecap(now: number = Date.now()): Promise<RecapAttemptResult> {
    const unsent = this.oldestUnemailedRecap();
    if (unsent) return this.sendStoredRecap(unsent);

    const settings = this.readSettings();
    const state = await this.loadNflState();
    // Pending attempts retry all week. Thursday through Monday the current week is in progress.
    const current = canRecapCurrentWeek(easternParts(new Date(now)))
      ? await this.loadRecapWeek(settings.sleeperLeagueId, state.week)
      : null;
    const selected = selectRecapWeek({
      nflWeek: state.week,
      currentWeekPlayed: current != null && isPlayedWeek(current.matchups),
    });
    if (selected == null) return { status: "skipped_not_final" };

    let weekBundle = current;
    if (selected !== state.week || weekBundle == null) {
      weekBundle = await this.loadRecapWeek(settings.sleeperLeagueId, selected);
      if (!isPlayedWeek(weekBundle.matchups)) return { status: "skipped_not_final" };
    }

    const existing = this.readRecap(selected);
    if (existing) {
      if (existing.emailedAt != null) return { status: "skipped_already" };
      return this.sendStoredRecap(existing);
    }

    const sleeper = sleeperFromEnv(this.env);
    const [users, rosters, players] = await Promise.all([
      sleeper.getLeagueUsers(settings.sleeperLeagueId),
      sleeper.getRosters(settings.sleeperLeagueId),
      getPlayerMap(this.env, sleeper),
    ]);
    const snapshot: LeagueSnapshot = {
      leagueId: settings.leagueId,
      week: selected,
      users,
      rosters,
      matchups: weekBundle.matchups,
      transactions: weekBundle.transactions,
    };
    const facts = diffSnapshots(null, snapshot, players, { settled: true });
    // The selected week is played, so it counts in the season this recap is written against.
    if (this.recordFinalWeek(selected, weekBundle.matchups)) {
      this.writeCloseGames({ week: selected, matchups: weekBundle.matchups }, { users, rosters, players });
    }
    const season = this.seasonContext(
      { users, rosters, players },
      { week: selected, matchups: weekBundle.matchups, settled: true },
    );
    return this.attemptRecapWithGenerator(
      weekBundle.matchups,
      facts,
      async (storyFacts) => {
        const prompt = recapPrompt({
          tone: settings.tone,
          leagueName: settings.name,
          week: selected,
          bible: this.bibleLines(),
          season,
          facts: storyFacts,
        });
        return this.generateRecapDraft(prompt);
      },
      selected,
    );
  }

  async attemptRecapWithGenerator(
    matchups: SleeperMatchup[],
    facts: StoryFact[],
    generate: (facts: StoryFact[]) => Promise<RecapDraft>,
    week = this.latestSnapshot()?.week ?? 0,
  ): Promise<RecapAttemptResult> {
    // RPCs interleave while the model drafts. Callers for the same week share one attempt
    // so a week is drafted and archived once.
    const inFlight = this.recapAttempts.get(week);
    if (inFlight) return inFlight;
    const attempt = this.runRecapAttemptForWeek(matchups, facts, generate, week).finally(() => {
      this.recapAttempts.delete(week);
    });
    this.recapAttempts.set(week, attempt);
    return attempt;
  }

  private async runRecapAttemptForWeek(
    matchups: SleeperMatchup[],
    facts: StoryFact[],
    generate: (facts: StoryFact[]) => Promise<RecapDraft>,
    week: number,
  ): Promise<RecapAttemptResult> {
    const existing = this.readRecap(week);
    if (existing) {
      if (existing.emailedAt != null) return { status: "skipped_already" };
      return this.sendStoredRecap(existing);
    }
    try {
      return await runRecapAttempt({
        week,
        matchups,
        existingRecap: null,
        facts,
        generate,
        archive: async (recap) => {
          const now = Date.now();
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              "INSERT INTO recaps (week, subject, body, facts, emailed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              week,
              recap.subject,
              recap.body,
              JSON.stringify(facts),
              null,
              now,
            );
            this.insertBibleIfNew(`Week ${week} recap: ${recap.subject}`, now);
          });
        },
        email: async (recap) => {
          await this.deliverRecap(week, recap);
        },
      });
    } catch (error) {
      const row = this.readRecap(week);
      if (row && row.emailedAt == null) {
        console.error("recap email failed after archive", error);
        return { status: "email_pending" };
      }
      throw error;
    }
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

  /**
   * Publishes only if the latest snapshot is still the one the facts were diffed against.
   * RPCs interleave while the model drafts, so an overlapping poll may already have
   * published this payload or a newer one.
   */
  private publishBeat(
    snapshot: LeagueSnapshot,
    hash: string,
    facts: StoryFact[],
    draft: BeatDraft,
    baseHash: string | null,
    settled: boolean,
  ): boolean {
    const now = Date.now();
    const kind = facts[0].kind;
    return this.ctx.storage.transactionSync(() => {
      if ((this.latestSnapshot()?.hash ?? null) !== baseHash) return false;
      this.insertSnapshot(snapshot, hash, settled, now);
      this.ctx.storage.sql.exec(
        "INSERT INTO beats (kind, copy, facts, week, created_at) VALUES (?, ?, ?, ?, ?)",
        kind,
        draft.copy,
        JSON.stringify(facts),
        snapshot.week,
        now,
      );
      // Close games reach the bible from final scores when their week settles, not from beats.
      for (const fact of facts) {
        if (fact.kind === "trade") this.insertBibleIfNew(fact.copy, now);
      }
      return true;
    });
  }

  private insertSnapshot(snapshot: LeagueSnapshot, hash: string, settled: boolean, now = Date.now()): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO snapshots (week, payload_hash, payload, created_at) VALUES (?, ?, ?, ?)",
      snapshot.week,
      hash,
      JSON.stringify(snapshot),
      now,
    );
    this.putSetting(LATEST_SNAPSHOT_SETTLED_KEY, settled ? "1" : "0");
  }

  private insertBibleIfNew(entry: string, now = Date.now()): void {
    const existing = this.ctx.storage.sql.exec("SELECT id FROM bible WHERE entry = ? LIMIT 1", entry).toArray();
    if (existing.length > 0) return;
    this.ctx.storage.sql.exec("INSERT INTO bible (entry, created_at) VALUES (?, ?)", entry, now);
  }

  private oldestUnemailedRecap(): { week: number; subject: string; body: string } | null {
    const row = this.ctx.storage.sql
      .exec("SELECT week, subject, body FROM recaps WHERE emailed_at IS NULL ORDER BY week ASC LIMIT 1")
      .toArray()[0] as { week: number; subject: string; body: string } | undefined;
    return row ?? null;
  }

  private readRecap(week: number): { week: number; subject: string; body: string; emailedAt: number | null } | null {
    const row = this.ctx.storage.sql
      .exec("SELECT week, subject, body, emailed_at AS emailedAt FROM recaps WHERE week = ?", week)
      .toArray()[0] as { week: number; subject: string; body: string; emailedAt: number | null } | undefined;
    return row ?? null;
  }

  private async sendStoredRecap(row: {
    week: number;
    subject: string;
    body: string;
  }): Promise<RecapAttemptResult> {
    const recap = { subject: row.subject, body: row.body };
    try {
      await this.deliverRecap(row.week, recap);
      return { status: "published", recap };
    } catch (error) {
      console.error("recap email failed after archive", error);
      return { status: "email_pending" };
    }
  }

  private deliverRecap(week: number, recap: RecapDraft): Promise<void> {
    // RPCs interleave while sends are in flight. Callers for the same week share one delivery
    // so the recipient list is never read twice before sends are recorded.
    const inFlight = this.recapDeliveries.get(week);
    if (inFlight) return inFlight;
    const delivery = this.sendRecapToRecipients(week, recap).finally(() => {
      this.recapDeliveries.delete(week);
    });
    this.recapDeliveries.set(week, delivery);
    return delivery;
  }

  private async sendRecapToRecipients(week: number, recap: RecapDraft): Promise<void> {
    const settings = this.readSettings();
    const recipients = await listRecapRecipients(this.env.DB, settings.leagueId);
    if (recipients.length === 0) {
      this.markRecapEmailed(week);
      return;
    }
    const message = recapEmail(recap);
    const before = this.recapDeliveryState(week);
    // Record each send as it lands so a retry after a partial failure skips who already got it.
    const results = await Promise.allSettled(
      recipients
        .filter((recipient) => before.outstanding(recipient.email))
        .map(async (recipient) => {
          try {
            await sendEmail(this.env.EMAIL, {
              from: this.env.EMAIL_FROM,
              to: recipient.email,
              subject: message.subject,
              text: message.text,
            });
          } catch (error) {
            this.ctx.storage.sql.exec(
              `INSERT INTO recap_delivery_failures (week, email, failures) VALUES (?, ?, 1)
               ON CONFLICT(week, email) DO UPDATE SET failures = failures + 1`,
              week,
              recipient.email,
            );
            throw error;
          }
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO recap_deliveries (week, email, sent_at) VALUES (?, ?, ?)",
            week,
            recipient.email,
            Date.now(),
          );
        }),
    );
    const failure = results.find((result) => result.status === "rejected");
    const after = this.recapDeliveryState(week);
    if (failure && recipients.some((recipient) => after.outstanding(recipient.email))) throw failure.reason;
    const dropped = recipients.filter((recipient) => !after.delivered.has(recipient.email)).length;
    if (dropped > 0) {
      // Omit addresses. Operators get the week and a count only.
      console.warn(JSON.stringify({ event: "league_brain.recap_delivery_abandoned", week, recipients: dropped }));
    }
    this.markRecapEmailed(week);
  }

  private recapDeliveryState(week: number): { delivered: Set<string>; outstanding(email: string): boolean } {
    const delivered = new Set(
      (
        this.ctx.storage.sql.exec("SELECT email FROM recap_deliveries WHERE week = ?", week).toArray() as Array<{
          email: string;
        }>
      ).map((row) => row.email),
    );
    const exhausted = new Set(
      (
        this.ctx.storage.sql
          .exec(
            "SELECT email FROM recap_delivery_failures WHERE week = ? AND failures >= ?",
            week,
            MAX_RECAP_DELIVERY_FAILURES,
          )
          .toArray() as Array<{ email: string }>
      ).map((row) => row.email),
    );
    return { delivered, outstanding: (email) => !delivered.has(email) && !exhausted.has(email) };
  }

  private markRecapEmailed(week: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE recaps SET emailed_at = ? WHERE week = ? AND emailed_at IS NULL",
      Date.now(),
      week,
    );
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

    // Mark pending before the export RPC. That await yields the DO input gate, so
    // concurrent poll/attemptRecap/dashboard must see pending and refuse to seed history.
    this.markLegacyImportPending();
    const legacy = await this.exportLegacyStateFromSource(input.sleeperLeagueId, input.leagueId);
    // Re-read completion markers before writing so a concurrent bootstrap cannot
    // look "done" with a partial copy.
    if (this.getSetting(LEGACY_MIGRATED_FROM_KEY)) {
      this.ctx.storage.transactionSync(() => this.clearLegacyImportInFlight());
      return;
    }
    if (this.getSetting(LEGACY_IMPORT_ABANDONED_KEY)) {
      this.deleteSetting(LEGACY_IMPORT_PENDING_KEY);
      return;
    }
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
        this.markLegacyImportPending();
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

  private markLegacyImportPending(): void {
    this.putSetting(LEGACY_IMPORT_PENDING_KEY, "1");
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
    const name = this.getSetting("name");
    const tone = this.getSetting("tone");
    const bible =
      name && tone && isTone(tone)
        ? this.ctx.storage.sql
            .exec("SELECT entry FROM bible WHERE entry != ? LIMIT 1", bootstrapBibleEntry(name, tone))
            .toArray()
        : this.ctx.storage.sql.exec("SELECT entry FROM bible LIMIT 1").toArray();
    return bible.length > 0;
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
    for (const row of legacy.recapDeliveries ?? []) {
      this.insertLegacyRowOrIdentical(
        "INSERT OR IGNORE INTO recap_deliveries (week, email, sent_at) VALUES (?, ?, ?)",
        [row.week, row.email, row.sentAt],
        "SELECT week, email, sent_at AS sentAt FROM recap_deliveries WHERE week = ? AND email = ?",
        [row.week, row.email],
        { week: row.week, email: row.email, sentAt: row.sentAt },
      );
    }
    for (const row of legacy.recapDeliveryFailures ?? []) {
      this.insertLegacyRowOrIdentical(
        "INSERT OR IGNORE INTO recap_delivery_failures (week, email, failures) VALUES (?, ?, ?)",
        [row.week, row.email, row.failures],
        "SELECT week, email, failures FROM recap_delivery_failures WHERE week = ? AND email = ?",
        [row.week, row.email],
        { week: row.week, email: row.email, failures: row.failures },
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
