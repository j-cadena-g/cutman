import { DurableObject } from "cloudflare:workers";
import { generateBeat, generateRecap, type WorkersAi } from "@cutman/ai";
import { listRecapRecipients } from "@cutman/db";
import { recapEmail, sendEmail } from "@cutman/email";
import type { PlayerMap, SleeperMatchup } from "@cutman/sleeper";
import {
  beatPrompt,
  diffSnapshots,
  factsIfChanged,
  hashSnapshot,
  recapPrompt,
  runRecapAttempt,
  type BeatDraft,
  type LeagueSnapshot,
  type RecapAttemptResult,
  type RecapDraft,
  type StoryFact,
  type Tone,
} from "@cutman/story";
import { getPlayerMap, sleeperFromEnv } from "./sleeper.ts";

type Settings = {
  leagueId: string;
  name: string;
  tone: Tone;
};

export type Dashboard = {
  leagueId: string;
  name: string;
  tone: Tone;
  week: number | null;
  lastHash: string | null;
  bible: Array<{ id: number; entry: string; createdAt: number }>;
  timeline: Array<{ id: number; kind: string; copy: string; week: number; createdAt: number }>;
  recaps: Array<{ week: number; subject: string; body: string; createdAt: number }>;
};

export class LeagueBrain extends DurableObject<Env> {
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
  }

  async bootstrap(input: { leagueId: string; name: string; tone: Tone }): Promise<void> {
    this.putSetting("leagueId", input.leagueId);
    this.putSetting("name", input.name);
    this.putSetting("tone", input.tone);
    const existing = this.ctx.storage.sql.exec("SELECT id FROM bible LIMIT 1").toArray();
    if (existing.length === 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO bible (entry, created_at) VALUES (?, ?)",
        `${input.name} is in the book. Tone: ${input.tone}.`,
        Date.now(),
      );
    }
  }

  async setTone(tone: Tone): Promise<void> {
    this.putSetting("tone", tone);
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
      sleeper.getLeagueUsers(settings.leagueId),
      sleeper.getRosters(settings.leagueId),
      sleeper.getMatchups(settings.leagueId, state.week),
      sleeper.getTransactions(settings.leagueId, state.week),
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
    const leagueId = this.getSetting("leagueId");
    const name = this.getSetting("name") ?? "Untitled league";
    const tone = (this.getSetting("tone") as Tone | null) ?? "playful";
    if (!leagueId) throw new Error("Cutman is not bootstrapped");
    return { leagueId, name, tone };
  }

  private getSetting(key: string): string | null {
    const row = this.ctx.storage.sql.exec("SELECT value FROM settings WHERE key = ?", key).toArray()[0] as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private putSetting(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}
