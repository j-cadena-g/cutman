import type { LeagueMemberRow, LeagueRow } from "@cutman/db";

// Pure view-state for the `/onboarding` pilot-league step, plus typed-error copy shared by every
// onboarding action. Deliberately free of D1/Sleeper/Clerk imports — app/routes/onboarding.tsx's
// loader gathers the inputs (Sleeper connection, discovered pilot-league membership, the DB
// league/membership rows, and any pending verification) and this module decides what to render,
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

export type OnboardingErrorKind =
  | "invalid_username"
  | "sleeper_user_not_found"
  | "sleeper_account_connected_to_another_user"
  | "clerk_user_already_connected_to_different_sleeper_account"
  | "sleeper_account_not_linked"
  | "not_a_pilot_league_member"
  | "not_owner"
  | "no_pending_challenge"
  | "sleeper_account_mismatch"
  | "challenge_expired"
  | "challenge_not_found_in_team_name"
  | "challenge_already_used"
  | "pilot_league_not_found"
  | "pilot_league_not_active"
  | "not_commissioner"
  | "provisioning_failed";

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
      return "That verification code expired. Request a new one and finish verifying within 15 minutes.";
    case "challenge_not_found_in_team_name":
      return "Cutman didn't find your code in your Sleeper team name yet. Save the rename on Sleeper, then verify again.";
    case "challenge_already_used":
      return "That verification code was already used. Request a new one if you still need to verify.";
    case "pilot_league_not_found":
      return "Cutman couldn't read this league from Sleeper right now. Try again in a moment.";
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
