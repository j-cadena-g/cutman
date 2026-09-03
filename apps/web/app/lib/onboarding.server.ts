import {
  consumeVerification,
  createLeague,
  ensureLeagueMember,
  findPendingVerification,
  getLeagueBySleeperId,
  getSleeperAccountByUserId,
  getSleeperAccountBySleeperUserId,
  getVerification,
  linkSleeperAccount,
  recordVerificationAttempt,
  refreshSleeperAccount,
  reissueVerification,
  upsertLeagueMember,
  type LeagueMemberRow,
  type LeagueRow,
  type SleeperAccountRow,
} from "@cutman/db";
import type { SleeperClient } from "@cutman/sleeper";

// Testable server-side services for Sleeper onboarding: connecting one Clerk user to one Sleeper
// account, discovering their leagues for the current season, the commissioner team-name
// challenge for the configured pilot league, and joining an already-active pilot league as a
// member. Route/UI wiring and LeagueBrain provisioning are later tasks — nothing here touches
// react-router loaders/actions or the LeagueBrain Durable Object.
//
// `SleeperClient`, the clock, id generation, and challenge generation are all injected so tests
// are deterministic and never hit the real Sleeper API.
export type OnboardingDeps = {
  db: D1Database;
  sleeperClient: SleeperClient;
  // The Sleeper league id for the single configured pilot league (the same value the rest of the
  // app calls `V1_LEAGUE_ID` / `v1LeagueId(env)` — see app/lib/v1.server.ts). Passed explicitly
  // here, rather than read from `Env`, to keep this module a plain, testable service.
  pilotSleeperLeagueId: string;
  now: () => number;
  generateChallenge: () => string;
  generateId: () => string;
  challengeTtlMs?: number;
};

export const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000;

function challengeTtlMs(deps: OnboardingDeps): number {
  return deps.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
}

// Excludes visually ambiguous characters (0/O, 1/I/L) so a challenge is easy to read and retype
// into a Sleeper team name.
const UNAMBIGUOUS_CHALLENGE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// Cryptographically secure by default (Workers/Node both expose `crypto.getRandomValues` as a
// global). Tests inject a deterministic `random` source instead of relying on this default.
function secureRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  // 2**32, so the result is always in [0, 1).
  return buffer[0]! / 4_294_967_296;
}

export function createChallengeCode(random: () => number = secureRandom): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    const index = Math.floor(random() * UNAMBIGUOUS_CHALLENGE_CHARS.length);
    suffix += UNAMBIGUOUS_CHALLENGE_CHARS[index];
  }
  return `CUTMAN-${suffix}`;
}

// ---------------------------------------------------------------------------
// Connect one Clerk user to one Sleeper account.
// ---------------------------------------------------------------------------

export type ConnectSleeperAccountInput = {
  clerkUserId: string;
  usernameInput: string;
};

export type ConnectSleeperAccountError =
  | { kind: "invalid_username" }
  | { kind: "sleeper_user_not_found"; username: string }
  | { kind: "sleeper_account_connected_to_another_user" }
  | { kind: "clerk_user_already_connected_to_different_sleeper_account"; existingSleeperUserId: string };

export type ConnectSleeperAccountResult =
  | { ok: true; account: SleeperAccountRow; wasNewLink: boolean }
  | { ok: false; error: ConnectSleeperAccountError };

export async function connectSleeperAccount(
  deps: OnboardingDeps,
  input: ConnectSleeperAccountInput,
): Promise<ConnectSleeperAccountResult> {
  const username = input.usernameInput.trim();
  if (!username) {
    return { ok: false, error: { kind: "invalid_username" } };
  }

  const sleeperUser = await deps.sleeperClient.getUser(username);
  if (!sleeperUser) {
    return { ok: false, error: { kind: "sleeper_user_not_found", username } };
  }

  const existingBySleeperId = await getSleeperAccountBySleeperUserId(deps.db, sleeperUser.user_id);
  if (existingBySleeperId && existingBySleeperId.user_id !== input.clerkUserId) {
    return { ok: false, error: { kind: "sleeper_account_connected_to_another_user" } };
  }

  const now = deps.now();
  const existingForUser = await getSleeperAccountByUserId(deps.db, input.clerkUserId);
  if (existingForUser && existingForUser.sleeper_user_id !== sleeperUser.user_id) {
    return {
      ok: false,
      error: {
        kind: "clerk_user_already_connected_to_different_sleeper_account",
        existingSleeperUserId: existingForUser.sleeper_user_id,
      },
    };
  }

  if (existingForUser) {
    const refreshed = await refreshSleeperAccount(deps.db, {
      userId: input.clerkUserId,
      username: sleeperUser.username,
      displayName: sleeperUser.display_name,
      now,
    });
    return { ok: true, account: refreshed, wasNewLink: false };
  }

  try {
    const linked = await linkSleeperAccount(deps.db, {
      userId: input.clerkUserId,
      sleeperUserId: sleeperUser.user_id,
      username: sleeperUser.username,
      displayName: sleeperUser.display_name,
      now,
    });
    return { ok: true, account: linked, wasNewLink: true };
  } catch (error) {
    // A concurrent request may have inserted a `sleeper_accounts` row for this exact Sleeper
    // user id (unique) or this exact Clerk user id (primary key) between our pre-checks above
    // and this insert — the pre-checks above only ruled out rows that existed *before* this
    // call started. Re-read instead of surfacing the raw D1 constraint error.
    const raced = await getSleeperAccountBySleeperUserId(deps.db, sleeperUser.user_id);
    if (raced && raced.user_id !== input.clerkUserId) {
      return { ok: false, error: { kind: "sleeper_account_connected_to_another_user" } };
    }
    if (raced && raced.user_id === input.clerkUserId) {
      // A concurrent duplicate request for this same Clerk user won the race first; treat this
      // as the (idempotent) linked outcome instead of surfacing the raw constraint error.
      return { ok: true, account: raced, wasNewLink: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Discover the connected user's current-season leagues.
// ---------------------------------------------------------------------------

export type LeagueClassification = "pilot" | "coming_soon";

export type DiscoveredLeague = {
  sleeperLeagueId: string;
  name: string;
  season: string;
  classification: LeagueClassification;
  isOwner: boolean;
};

export type DiscoverLeaguesError = { kind: "sleeper_account_not_linked" };

export type DiscoverLeaguesResult =
  | { ok: true; season: string; leagues: DiscoveredLeague[] }
  | { ok: false; error: DiscoverLeaguesError };

export async function discoverLeagues(
  deps: OnboardingDeps,
  input: { clerkUserId: string },
): Promise<DiscoverLeaguesResult> {
  const account = await getSleeperAccountByUserId(deps.db, input.clerkUserId);
  if (!account) {
    return { ok: false, error: { kind: "sleeper_account_not_linked" } };
  }

  const nflState = await deps.sleeperClient.getNflState();
  const season = nflState.league_season;
  const sleeperLeagues = await deps.sleeperClient.getUserLeagues(account.sleeper_user_id, season);

  // Sequential, bounded by design: a user can belong to many Sleeper leagues, and firing every
  // `getLeagueUsers` call at once would be an unbounded fan-out against the Sleeper API for a
  // single request. A plain sequential loop keeps at most one in-flight call, and — since
  // ownership is derived per-league from that league's own roster, not from array order — the
  // "not insertion order" requirement holds the same way it would with `Promise.all`.
  const leagues: DiscoveredLeague[] = [];
  for (const league of sleeperLeagues) {
    const members = await deps.sleeperClient.getLeagueUsers(league.league_id);
    const entry = members.find((member) => member.user_id === account.sleeper_user_id);
    leagues.push({
      sleeperLeagueId: league.league_id,
      name: league.name,
      season: league.season,
      classification: league.league_id === deps.pilotSleeperLeagueId ? "pilot" : "coming_soon",
      isOwner: Boolean(entry?.is_owner),
    });
  }

  return { ok: true, season, leagues };
}

// ---------------------------------------------------------------------------
// Commissioner team-name challenge: request.
// ---------------------------------------------------------------------------

export type RequestCommissionerChallengeError =
  | { kind: "sleeper_account_not_linked" }
  | { kind: "not_a_pilot_league_member" }
  | { kind: "not_owner" };

export type RequestCommissionerChallengeResult =
  | { ok: true; verificationId: string; challenge: string; expiresAt: number }
  | { ok: false; error: RequestCommissionerChallengeError };

export async function requestCommissionerChallenge(
  deps: OnboardingDeps,
  input: { clerkUserId: string },
): Promise<RequestCommissionerChallengeResult> {
  const account = await getSleeperAccountByUserId(deps.db, input.clerkUserId);
  if (!account) {
    return { ok: false, error: { kind: "sleeper_account_not_linked" } };
  }

  const members = await deps.sleeperClient.getLeagueUsers(deps.pilotSleeperLeagueId);
  const entry = members.find((member) => member.user_id === account.sleeper_user_id);
  if (!entry) {
    return { ok: false, error: { kind: "not_a_pilot_league_member" } };
  }
  // Only a *current* Sleeper `is_owner` may request a challenge.
  if (!entry.is_owner) {
    return { ok: false, error: { kind: "not_owner" } };
  }

  const now = deps.now();
  // `reissueVerification` supersedes (expires) any still-pending challenge for this user+league
  // and carries its `attempts` count forward, so requesting a new challenge can't be used to
  // trivially reset an attempts counter, and at most one challenge stays "pending" at a time.
  const verification = await reissueVerification(deps.db, {
    id: deps.generateId(),
    userId: input.clerkUserId,
    sleeperUserId: account.sleeper_user_id,
    sleeperLeagueId: deps.pilotSleeperLeagueId,
    challenge: deps.generateChallenge(),
    expiresAt: now + challengeTtlMs(deps),
    now,
  });

  return {
    ok: true,
    verificationId: verification.id,
    challenge: verification.challenge,
    expiresAt: verification.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Commissioner team-name challenge: verify.
// ---------------------------------------------------------------------------

export type VerifyCommissionerChallengeError =
  | { kind: "sleeper_account_not_linked" }
  | { kind: "no_pending_challenge" }
  | { kind: "sleeper_account_mismatch" }
  | { kind: "challenge_expired" }
  | { kind: "not_owner" }
  | { kind: "challenge_not_found_in_team_name" }
  | { kind: "challenge_already_used" }
  | { kind: "pilot_league_not_found" };

export type VerifyCommissionerChallengeResult =
  | { ok: true; league: LeagueRow; membership: LeagueMemberRow }
  | { ok: false; error: VerifyCommissionerChallengeError };

export async function verifyCommissionerChallenge(
  deps: OnboardingDeps,
  input: { clerkUserId: string },
): Promise<VerifyCommissionerChallengeResult> {
  const account = await getSleeperAccountByUserId(deps.db, input.clerkUserId);
  if (!account) {
    return { ok: false, error: { kind: "sleeper_account_not_linked" } };
  }

  const verification = await findPendingVerification(deps.db, {
    userId: input.clerkUserId,
    sleeperLeagueId: deps.pilotSleeperLeagueId,
  });
  if (!verification) {
    return { ok: false, error: { kind: "no_pending_challenge" } };
  }

  // The connected Sleeper account may have changed (disconnect/reconnect to a different Sleeper
  // user) between requesting and verifying the challenge. Compare the *currently* connected
  // stable Sleeper user id against the one the challenge was actually issued for — a mismatch
  // means this challenge does not belong to whoever is connected right now, regardless of what
  // Sleeper's league roster says.
  if (account.sleeper_user_id !== verification.sleeper_user_id) {
    return { ok: false, error: { kind: "sleeper_account_mismatch" } };
  }

  const now = deps.now();
  if (verification.expires_at <= now) {
    await recordVerificationAttempt(deps.db, { id: verification.id, now });
    return { ok: false, error: { kind: "challenge_expired" } };
  }

  const members = await deps.sleeperClient.getLeagueUsers(deps.pilotSleeperLeagueId);
  // Re-check against the *same stable Sleeper user* the challenge was issued for (already
  // confirmed above to match the currently connected account), not insertion order.
  const entry = members.find((member) => member.user_id === verification.sleeper_user_id);
  if (!entry || !entry.is_owner) {
    await recordVerificationAttempt(deps.db, { id: verification.id, now });
    return { ok: false, error: { kind: "not_owner" } };
  }

  const teamName = entry.metadata?.team_name ?? "";
  if (!teamName.toLowerCase().includes(verification.challenge.toLowerCase())) {
    await recordVerificationAttempt(deps.db, { id: verification.id, now });
    return { ok: false, error: { kind: "challenge_not_found_in_team_name" } };
  }

  // Resolve the league's name/season before consuming the challenge, so an unexpected Sleeper
  // API failure here doesn't burn the user's one-time verification for nothing.
  let league = await getLeagueBySleeperId(deps.db, deps.pilotSleeperLeagueId);
  if (!league) {
    const sleeperLeague = await deps.sleeperClient.getLeague(deps.pilotSleeperLeagueId);
    if (!sleeperLeague) {
      return { ok: false, error: { kind: "pilot_league_not_found" } };
    }
    league = await createLeague(deps.db, {
      id: deps.pilotSleeperLeagueId,
      sleeperLeagueId: deps.pilotSleeperLeagueId,
      name: sleeperLeague.name,
      season: sleeperLeague.season,
      now,
    });
  }

  // Consumes the challenge exactly once via an atomic compare-and-swap in @cutman/db. That CAS
  // can lose to a concurrent verify/expire of the *same* verification (e.g. a double-submitted
  // request, or the TTL lapsing in the gap between the expiry check above and this call) — catch
  // that instead of letting a raw Error escape this service's discriminated result type.
  // Intentionally does not activate the league or bootstrap LeagueBrain — that belongs to a
  // later task.
  try {
    await consumeVerification(deps.db, { id: verification.id, now });
  } catch {
    const current = await getVerification(deps.db, verification.id);
    if (current?.status === "expired") {
      return { ok: false, error: { kind: "challenge_expired" } };
    }
    // Already verified (a concurrent winner beat us to it) or failed: either way this exact
    // one-time challenge cannot be consumed again.
    return { ok: false, error: { kind: "challenge_already_used" } };
  }

  const membership = await upsertLeagueMember(deps.db, {
    leagueId: league.id,
    userId: input.clerkUserId,
    role: "commissioner",
    now,
  });

  return { ok: true, league, membership };
}

// ---------------------------------------------------------------------------
// Join an already-active pilot league as a member.
// ---------------------------------------------------------------------------

export type JoinPilotLeagueError =
  | { kind: "sleeper_account_not_linked" }
  | { kind: "pilot_league_not_active" }
  | { kind: "not_a_pilot_league_member" };

export type JoinPilotLeagueResult =
  | { ok: true; league: LeagueRow; membership: LeagueMemberRow }
  | { ok: false; error: JoinPilotLeagueError };

export async function joinPilotLeague(
  deps: OnboardingDeps,
  input: { clerkUserId: string },
): Promise<JoinPilotLeagueResult> {
  const account = await getSleeperAccountByUserId(deps.db, input.clerkUserId);
  if (!account) {
    return { ok: false, error: { kind: "sleeper_account_not_linked" } };
  }

  const league = await getLeagueBySleeperId(deps.db, deps.pilotSleeperLeagueId);
  if (!league || league.status !== "active") {
    return { ok: false, error: { kind: "pilot_league_not_active" } };
  }

  const members = await deps.sleeperClient.getLeagueUsers(deps.pilotSleeperLeagueId);
  const entry = members.find((member) => member.user_id === account.sleeper_user_id);
  if (!entry) {
    return { ok: false, error: { kind: "not_a_pilot_league_member" } };
  }

  // `ensureLeagueMember` defaults a brand-new row to "member" and never overwrites an existing
  // role, so an existing commissioner who joins again is never demoted.
  const membership = await ensureLeagueMember(deps.db, {
    leagueId: league.id,
    userId: input.clerkUserId,
    now: deps.now(),
  });

  return { ok: true, league, membership };
}
