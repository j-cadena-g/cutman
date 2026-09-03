import type { LeagueMemberRow, LeagueRow } from "@cutman/db";

// Pure view-state helpers for the home hub (`/`) and per-league authorization (`/leagues/:id`).
// Deliberately free of Clerk/D1 imports so they can be unit tested directly, without mocking
// Clerk or hitting a database — see app/lib/access.server.ts for the impure loaders that gather
// the inputs these functions decide over.

export type HomeDestination =
  | { kind: "needs_onboarding" }
  | { kind: "single_league"; league: LeagueRow }
  | { kind: "multiple_leagues"; leagues: LeagueRow[] };

// `/` is a hub: a signed-in user with no linked Sleeper account, or no *active* league
// membership, belongs on `/onboarding`. Provisioning-only memberships (e.g. a commissioner who
// just verified but whose league Task 4 hasn't activated yet) intentionally do not count as an
// active league here — that in-between state is `/onboarding`'s job to render (see
// app/lib/onboarding-view.ts's "provisioning" step), not the hub's. Callers are responsible for
// pre-filtering `activeLeagues` to `status === "active"`.
export function computeHomeDestination(input: {
  sleeperConnected: boolean;
  activeLeagues: LeagueRow[];
}): HomeDestination {
  if (!input.sleeperConnected || input.activeLeagues.length === 0) {
    return { kind: "needs_onboarding" };
  }
  if (input.activeLeagues.length === 1) {
    return { kind: "single_league", league: input.activeLeagues[0]! };
  }
  return { kind: "multiple_leagues", leagues: input.activeLeagues };
}

export type LeagueAuthorization =
  | { kind: "not_found" }
  | { kind: "not_active" }
  | { kind: "authorized"; isOwner: boolean };

// `/leagues/:leagueId` requires Clerk *and* membership in that exact active league. `not_found`
// deliberately covers both "no such league" and "you are not a member of it" — a signed-in user
// can never distinguish "this league doesn't exist" from "you're not on it" (reject cross-league
// access without leaking which leagues exist). The membership row's own `league_id` is checked
// against the league being accessed, not just truthiness, so a membership object fetched for the
// wrong league can never authorize this one.
export function authorizeLeagueAccess(input: {
  league: LeagueRow | null;
  membership: LeagueMemberRow | null;
}): LeagueAuthorization {
  if (!input.league || !input.membership || input.membership.league_id !== input.league.id) {
    return { kind: "not_found" };
  }
  if (input.league.status !== "active") {
    return { kind: "not_active" };
  }
  return { kind: "authorized", isOwner: input.membership.role === "commissioner" };
}
