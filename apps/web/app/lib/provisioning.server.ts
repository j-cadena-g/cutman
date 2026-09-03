import {
  activateLeague,
  failLeague,
  getLeague,
  provisionLeague,
  type LeagueMemberRow,
  type LeagueRow,
} from "@cutman/db";
import { toneOrPlayful, type Tone } from "@cutman/story";

// Focused post-verify service: take an already-created `LeagueRow` (status provisioning/error/active),
// bootstrap+poll that league's Durable Object, then CAS D1 to `active`. Verify stays separate —
// `verifyCommissionerChallenge` must not call this. Concurrent retries converge on active without
// throwing; failures mark D1 `error` with a short diagnostic and a typed retryable result.

export type LeagueBrainHandle = {
  bootstrap(input: { leagueId: string; sleeperLeagueId: string; name: string; tone: Tone }): Promise<void>;
  poll(): Promise<unknown>;
};

export type ProvisioningDeps = {
  db: D1Database;
  brain: LeagueBrainHandle;
  now: () => number;
};

export type ProvisionLeagueError = { kind: "provisioning_failed" };

export type ProvisionLeagueResult =
  | { ok: true; league: LeagueRow }
  | { ok: false; error: ProvisionLeagueError };

export type RetryProvisionError = { kind: "not_commissioner" } | ProvisionLeagueError;

export type RetryProvisionResult =
  | { ok: true; league: LeagueRow }
  | { ok: false; error: RetryProvisionError };

export function provisioningDepsFromEnv(env: Env, leagueId: string, now: () => number = () => Date.now()): ProvisioningDeps {
  return {
    db: env.DB,
    brain: env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(leagueId)),
    now,
  };
}

function safeProvisioningError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.replace(/\s+/g, " ").trim().slice(0, 240);
    if (message) return message;
  }
  return "League setup failed";
}

async function readLeague(db: D1Database, leagueId: string): Promise<LeagueRow> {
  const row = await getLeague(db, leagueId);
  if (!row) throw new Error(`League "${leagueId}" not found`);
  return row;
}

export async function provisionAndActivateLeague(
  deps: ProvisioningDeps,
  league: LeagueRow,
): Promise<ProvisionLeagueResult> {
  if (league.status === "active") {
    return { ok: true, league };
  }

  let current = league;
  if (current.status === "error") {
    try {
      current = await provisionLeague(deps.db, current.id);
    } catch {
      const raced = await readLeague(deps.db, current.id);
      if (raced.status === "active") return { ok: true, league: raced };
      if (raced.status === "error") return { ok: false, error: { kind: "provisioning_failed" } };
      current = raced;
    }
  }

  try {
    await deps.brain.bootstrap({
      leagueId: current.id,
      sleeperLeagueId: current.sleeper_league_id,
      name: current.name,
      tone: toneOrPlayful(current.tone),
    });
    await deps.brain.poll();
  } catch (error) {
    return failOrConverge(deps, current.id, error);
  }

  try {
    const activated = await activateLeague(deps.db, current.id, deps.now());
    return { ok: true, league: activated };
  } catch {
    const raced = await readLeague(deps.db, current.id);
    if (raced.status === "active") return { ok: true, league: raced };
    if (raced.status === "error") return { ok: false, error: { kind: "provisioning_failed" } };
    return failOrConverge(deps, current.id, new Error("Could not activate league"));
  }
}

async function failOrConverge(
  deps: ProvisioningDeps,
  leagueId: string,
  error: unknown,
): Promise<ProvisionLeagueResult> {
  const diagnostic = safeProvisioningError(error);
  try {
    await failLeague(deps.db, leagueId, diagnostic);
    return { ok: false, error: { kind: "provisioning_failed" } };
  } catch {
    const raced = await readLeague(deps.db, leagueId);
    if (raced.status === "active") return { ok: true, league: raced };
    return { ok: false, error: { kind: "provisioning_failed" } };
  }
}

export async function retryProvisionAndActivateLeague(
  deps: ProvisioningDeps,
  input: { league: LeagueRow | null; membership: LeagueMemberRow | null },
): Promise<RetryProvisionResult> {
  if (
    !input.league ||
    !input.membership ||
    input.membership.role !== "commissioner" ||
    input.membership.league_id !== input.league.id
  ) {
    return { ok: false, error: { kind: "not_commissioner" } };
  }
  return provisionAndActivateLeague(deps, input.league);
}
