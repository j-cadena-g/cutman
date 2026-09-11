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
  // Clock for the shared bootstrap+poll deadline. Defaults to Date.now, which is a wall clock
  // and can step; tests inject this (or fake timers) so the remaining budget stays deterministic.
  clock?: () => number;
};

export const PROVISION_TIMEOUT_MS = 20_000;

const PROVISION_TIMEOUT_MESSAGE = "League setup timed out";

function provisionClock(deps: ProvisioningDeps): () => number {
  return deps.clock ?? Date.now;
}

// Bootstrap then poll share one 20s deadline. Remaining is computed before each RPC — a
// depleted budget rejects immediately without starting the next call — and each promise is
// raced using only that remaining time. The race timer is always cleared. LeagueBrain RPC
// cannot be cancelled; a timeout still rejects here so the caller can failOrConverge. A late
// RPC may still finish and race a peer that already activated (CAS miss → success) or leave
// the league in error for retry.
async function withProvisionTimeout<T>(start: () => Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) {
    throw new Error(PROVISION_TIMEOUT_MESSAGE);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(PROVISION_TIMEOUT_MESSAGE));
      }, remainingMs);
    });
    return await Promise.race([start(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
    // Same function as persistence timestamps so injected fake time also drives the
    // bootstrap/poll deadline. Tests that need a distinct deadline clock construct
    // ProvisioningDeps directly.
    clock: now,
  };
}

function safeProvisioningError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.replace(/\s+/g, " ").trim().slice(0, 240);
    if (message) return message;
  }
  return "League setup failed";
}

async function recoverLeagueRow(db: D1Database, leagueId: string): Promise<LeagueRow | null> {
  try {
    return await getLeague(db, leagueId);
  } catch {
    return null;
  }
}

export async function provisionAndActivateLeague(
  deps: ProvisioningDeps,
  league: LeagueRow,
): Promise<ProvisionLeagueResult> {
  if (league.status === "active") {
    return { ok: true, league };
  }

  const attemptStartedAt = deps.now();
  let current = league;
  try {
    current = await provisionLeague(deps.db, current.id, attemptStartedAt);
  } catch {
    const raced = await recoverLeagueRow(deps.db, current.id);
    if (!raced || raced.status === "error") return { ok: false, error: { kind: "provisioning_failed" } };
    if (raced.status === "active") return { ok: true, league: raced };
    current = raced;
  }

  if (current.status === "active") {
    return { ok: true, league: current };
  }

  try {
    const clock = provisionClock(deps);
    const deadline = clock() + PROVISION_TIMEOUT_MS;
    await withProvisionTimeout(
      () =>
        deps.brain.bootstrap({
          leagueId: current.id,
          sleeperLeagueId: current.sleeper_league_id,
          name: current.name,
          tone: toneOrPlayful(current.tone),
        }),
      deadline - clock(),
    );
    await withProvisionTimeout(() => deps.brain.poll(), deadline - clock());
  } catch (error) {
    return failOrConverge(deps, current.id, error);
  }

  try {
    const activated = await activateLeague(deps.db, current.id, deps.now());
    return { ok: true, league: activated };
  } catch {
    const raced = await recoverLeagueRow(deps.db, current.id);
    if (!raced || raced.status === "error") return { ok: false, error: { kind: "provisioning_failed" } };
    if (raced.status === "active") return { ok: true, league: raced };
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
    const raced = await recoverLeagueRow(deps.db, leagueId);
    if (raced?.status === "active") return { ok: true, league: raced };
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
