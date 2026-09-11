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
  // Ordinary active members (and already-verified commissioners) are redirected to
  // `/leagues/:id` by the `/onboarding` loader before this step is computed. Unverified Sleeper
  // owners of an already-active league stay on onboarding — 0002 migrated leagues have an
  // `active` row with every membership `role = "member"` and no commissioner yet. See
  // `shouldRedirectActiveOnboardingMember` and app/routes/onboarding.tsx's loader.
  | { kind: "already_member" }
  | { kind: "setup_error" };

// Membership-first: ordinary active members leave `/onboarding` for `/leagues/:id`. Do not
// redirect when this user is a current Sleeper owner who has not verified as commissioner —
// they still need the team-name challenge. Discovery-failed / missing `pilotEntry` keeps the
// redirect (do not trap an active member on onboarding during a Sleeper outage). Commissioners
// always redirect, even if Sleeper still lists them as owner.
export function shouldRedirectActiveOnboardingMember(input: {
  membership: LeagueMemberRow | null;
  league: LeagueRow | null;
  isOwner: boolean;
}): boolean {
  if (!input.membership || !input.league || input.league.status !== "active") return false;
  if (input.membership.role !== "commissioner" && input.isOwner) return false;
  return true;
}

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

  // A `leagues` row does not mean a commissioner exists: 0002 migrated leagues are already
  // `active` with every membership `role = "member"`. Unverified current Sleeper owners (or
  // anyone with a pending team-name challenge) must still see the challenge path. Ordinary
  // members and already-verified commissioners stay on already_member / join_available.
  const offerOwnerChallengeOnActiveLeague =
    input.league?.status === "active" &&
    input.membership != null &&
    input.membership.role !== "commissioner" &&
    (Boolean(input.pendingVerification) || input.pilotEntry?.isOwner === true);

  if (input.league && !offerOwnerChallengeOnActiveLeague) {
    switch (input.league.status) {
      case "error":
        return { kind: "setup_error" };
      case "provisioning":
        return { kind: "provisioning" };
      case "active":
        return confirmedMember ? { kind: "already_member" } : { kind: "join_available" };
      default: {
        const exhaustive: never = input.league.status;
        return exhaustive;
      }
    }
  }

  if (input.pendingVerification) {
    return {
      kind: "challenge_pending",
      challenge: input.pendingVerification.challenge,
      expiresAt: input.pendingVerification.expiresAt,
      attempts: input.pendingVerification.attempts,
    };
  }

  // No-league owners reach here with a non-null `pilotEntry` (the `!input.pilotEntry` check
  // above already returned `not_a_pilot_league_member`). Migrated-active unverified owners
  // reach here because `offerOwnerChallengeOnActiveLeague` skipped the already_member shortcut,
  // which requires `pilotEntry.isOwner`.
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
