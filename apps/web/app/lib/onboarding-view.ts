import type { LeagueMemberRow, LeagueRow } from "@cutman/db";
import type {
  ConnectSleeperAccountError,
  DiscoverLeaguesError,
  JoinPilotLeagueError,
  RequestCommissionerChallengeError,
  VerifyCommissionerChallengeError,
} from "./onboarding.server.ts";
import type { RetryProvisionError } from "./provisioning.server.ts";

// Pure view-state for the `/onboarding` pilot-league step, plus typed-error copy shared by every
// onboarding action. Runtime-free of D1/Sleeper/Clerk; error kinds are type-only imports from the
// server modules. The onboarding loader gathers the inputs and this module decides what to render,
// so the decision itself is unit-testable without a database or the real Sleeper API.
export type PilotLeagueStep =
  | { kind: "connect_sleeper_account" }
  | { kind: "discovery_unavailable" }
  | { kind: "not_a_pilot_league_member" }
  | { kind: "request_challenge" }
  | { kind: "challenge_pending"; challenge: string; expiresAt: number; attempts: number }
  | { kind: "awaiting_commissioner" }
  | { kind: "provisioning" }
  | { kind: "join_available" }
  // Kept for pure-function completeness (and its own unit tests below) even though the real
  // `/onboarding` loader never reaches it in practice: it redirects to `/leagues/:id` the moment
  // `membership && league && league.status === "active"` is true — the exact same condition that
  // would produce this step — before `computePilotLeagueStep` is ever called. See
  // app/routes/onboarding.tsx's loader.
  | { kind: "already_member" }
  | { kind: "setup_error" };

export function computePilotLeagueStep(input: {
  sleeperConnected: boolean;
  // True when the current call to `discoverLeagues` (a live Sleeper API read) threw/failed, so
  // `pilotEntry` below could not actually be determined this time and must not be trusted as
  // "definitely not a member".
  discoveryFailed: boolean;
  // The current user's entry for the pilot league from `discoverLeagues`, or null if no Sleeper
  // account is connected yet, discovery failed, or the connected account isn't in the pilot
  // league at all.
  pilotEntry: { isOwner: boolean } | null;
  // The pilot league's own row in `leagues`, or null before any commissioner has verified it.
  league: LeagueRow | null;
  // The current user's membership in that league, or null if they haven't joined/verified.
  membership: LeagueMemberRow | null;
  // The current user's outstanding commissioner challenge, or null if none is pending.
  pendingVerification: { challenge: string; expiresAt: number; attempts: number } | null;
}): PilotLeagueStep {
  if (!input.sleeperConnected) return { kind: "connect_sleeper_account" };

  // A persisted `membership` row is authoritative proof of belonging to the pilot league and
  // never depends on live Sleeper discovery — it settles the question on its own, before we even
  // consider whether discovery succeeded or what it found.
  const confirmedMember = Boolean(input.membership);

  if (!confirmedMember) {
    // Everything below an unconfirmed membership needs to know whether the connected Sleeper
    // account currently shows up in the pilot league. An existing `leagues` row must never offer
    // "Join" (or, at the route level, reveal its name) to someone that isn't confirmed — a
    // discovery failure must not be misread as "confirmed not a member" (false negative), and
    // "not a member" must not be misread as "go ahead and join" (false positive).
    if (input.discoveryFailed) return { kind: "discovery_unavailable" };
    if (!input.pilotEntry) return { kind: "not_a_pilot_league_member" };
  }

  // Once a `leagues` row exists, *someone* has already completed the commissioner challenge —
  // that decides the step for everyone, independent of whether this exact user did it (a
  // regular member never sees "request a challenge" just because the league happens to still be
  // provisioning). `confirmedMember` only matters to distinguish "already in" from "can join"
  // once the league is active.
  if (input.league) {
    if (input.league.status === "error") return { kind: "setup_error" };
    if (input.league.status === "provisioning") return { kind: "provisioning" };
    return confirmedMember ? { kind: "already_member" } : { kind: "join_available" };
  }

  if (input.pendingVerification) {
    return {
      kind: "challenge_pending",
      challenge: input.pendingVerification.challenge,
      expiresAt: input.pendingVerification.expiresAt,
      attempts: input.pendingVerification.attempts,
    };
  }

  // `pilotEntry` is guaranteed non-null here: `confirmedMember` is false whenever we reach this
  // line (the `input.league` branch above already returned for a confirmed member), and the
  // `!input.pilotEntry` check above already returned `not_a_pilot_league_member` otherwise.
  return input.pilotEntry?.isOwner ? { kind: "request_challenge" } : { kind: "awaiting_commissioner" };
}

export const STUCK_PROVISIONING_MS = 2 * 60 * 1000;

const MINUTE_MS = 60_000;

// Stuck-retry UI clock. Only a currently-provisioning league has an attempt start; a retry
// must surface `provisioning_started_at` (the latest attempt), not the original `created_at`.
// Null `provisioning_started_at` (legacy / pre-column rows) falls back to `created_at`.
export function provisioningStartedAtFromLeague(league: LeagueRow | null): number | null {
  if (!league || league.status !== "provisioning") return null;
  return league.provisioning_started_at ?? league.created_at;
}

// Client countdown copy for a pending commissioner challenge. `now === null` means no clock is
// available yet, so we render nothing rather than a flash of "expired". The onboarding route
// always passes a number: the serialized loader timestamp on SSR/first paint, then the client
// clock. Expiration is decided by `expiresAt <= now` — never by rounding remaining minutes
// down to zero while the deadline is still in the future.
export function formatChallengeCountdown(expiresAt: number, now: number | null): string | null {
  if (now === null) return null;
  if (expiresAt <= now) return "This code just expired — request a new one below.";
  const minutesLeft = Math.ceil((expiresAt - now) / MINUTE_MS);
  return `Expires in about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`;
}

export function isStuckProvisioning(
  startedAt: number | null,
  now: number,
  thresholdMs: number = STUCK_PROVISIONING_MS,
): boolean {
  return startedAt != null && now - startedAt >= thresholdMs;
}

export type OnboardingErrorKind =
  | ConnectSleeperAccountError["kind"]
  | DiscoverLeaguesError["kind"]
  | RequestCommissionerChallengeError["kind"]
  | VerifyCommissionerChallengeError["kind"]
  | JoinPilotLeagueError["kind"]
  | RetryProvisionError["kind"];

// Maps every onboarding.server.ts discriminated error kind to plain, action-oriented copy. Never
// echoes an internal error/exception string — each kind gets its own hand-written sentence. The
// exhaustive switch (with a `never` default) means a new error kind fails this file's typecheck
// until it's given real copy, instead of silently falling through to a generic message.
export function describeOnboardingError(kind: OnboardingErrorKind): string {
  switch (kind) {
    case "invalid_username":
      return "Enter your Sleeper username.";
    case "sleeper_user_not_found":
      return "Cutman couldn't find a Sleeper account with that username. Double-check the spelling and try again.";
    case "sleeper_account_connected_to_another_user":
      return "That Sleeper account is already connected to a different Cutman sign-in.";
    case "clerk_user_already_connected_to_different_sleeper_account":
      return "This sign-in is already connected to a different Sleeper account.";
    case "sleeper_account_not_linked":
      return "Connect your Sleeper account first.";
    case "not_a_pilot_league_member":
      return "That Sleeper account isn't in this league.";
    case "not_owner":
      return "Sleeper shows someone else as this league's current owner. Only the current owner can verify.";
    case "no_pending_challenge":
      return "Request a new verification code to continue.";
    case "sleeper_account_mismatch":
      return "Your connected Sleeper account changed since you requested this code. Request a new one.";
    case "challenge_expired":
      return "That verification code expired. Request a new one and finish verifying before it expires.";
    case "challenge_not_found_in_team_name":
      return "Cutman didn't find your code in your Sleeper team name yet. Save the rename on Sleeper, then verify again.";
    case "challenge_already_used":
      return "That verification code was already used. Request a new one if you still need to verify.";
    case "pilot_league_not_found":
      // Used both when Sleeper has no league for the configured id and when retry-provision
      // cannot find a D1 row for it. Copy is intentionally source-neutral — no Sleeper, no
      // league name or id.
      return "Cutman couldn't find this league right now. Try again in a moment.";
    case "pilot_league_not_active":
      return "This league isn't open for members yet.";
    case "not_commissioner":
      return "Only this league's commissioner can retry setup.";
    case "provisioning_failed":
      return "Cutman couldn't finish setting up this league. You can retry from this page.";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
