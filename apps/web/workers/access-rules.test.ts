import type { LeagueMemberRow, LeagueRow } from "@cutman/db";
import { describe, expect, it } from "vitest";
import { authorizeLeagueAccess, computeHomeDestination } from "../app/lib/access-rules.ts";

function makeLeague(overrides: Partial<LeagueRow> = {}): LeagueRow {
  return {
    id: "league_1",
    sleeper_league_id: "sleeper_league_1",
    name: "The Pilot",
    season: "2026",
    status: "active",
    tone: "playful",
    created_at: 0,
    activated_at: 0,
    provisioning_error: null,
    ...overrides,
  };
}

function makeMembership(overrides: Partial<LeagueMemberRow> = {}): LeagueMemberRow {
  return {
    league_id: "league_1",
    user_id: "user_1",
    role: "member",
    recap_email_opt_in: 0,
    created_at: 0,
    ...overrides,
  };
}

describe("computeHomeDestination", () => {
  it("needs onboarding when no Sleeper account is connected, even with active leagues", () => {
    const result = computeHomeDestination({ sleeperConnected: false, activeLeagues: [makeLeague()] });
    expect(result).toEqual({ kind: "needs_onboarding" });
  });

  it("needs onboarding when connected but there are zero active league memberships", () => {
    const result = computeHomeDestination({ sleeperConnected: true, activeLeagues: [] });
    expect(result).toEqual({ kind: "needs_onboarding" });
  });

  it("redirects to the single active league when there is exactly one", () => {
    const league = makeLeague({ id: "only_league" });
    const result = computeHomeDestination({ sleeperConnected: true, activeLeagues: [league] });
    expect(result).toEqual({ kind: "single_league", league });
  });

  it("shows league cards for every active league when there is more than one", () => {
    const first = makeLeague({ id: "league_a" });
    const second = makeLeague({ id: "league_b" });
    const result = computeHomeDestination({ sleeperConnected: true, activeLeagues: [first, second] });
    expect(result).toEqual({ kind: "multiple_leagues", leagues: [first, second] });
  });

  it("does not count a provisioning-only membership as an active league (caller must pre-filter)", () => {
    // computeHomeDestination trusts its `activeLeagues` input completely; this test documents
    // that a caller passing a non-active league here would incorrectly count it, which is why
    // app/lib/access.server.ts filters to `status === "active"` before calling this function.
    const provisioning = makeLeague({ status: "provisioning" });
    const result = computeHomeDestination({ sleeperConnected: true, activeLeagues: [provisioning] });
    expect(result).toEqual({ kind: "single_league", league: provisioning });
  });
});

describe("authorizeLeagueAccess", () => {
  it("rejects when the league does not exist", () => {
    const result = authorizeLeagueAccess({ league: null, membership: makeMembership() });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("rejects when there is no membership row at all", () => {
    const result = authorizeLeagueAccess({ league: makeLeague(), membership: null });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("rejects cross-league access: a membership row for a different league can never authorize this one", () => {
    const league = makeLeague({ id: "league_a" });
    const membershipForOtherLeague = makeMembership({ league_id: "league_b" });
    const result = authorizeLeagueAccess({ league, membership: membershipForOtherLeague });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("rejects a provisioning league even for its own commissioner", () => {
    const league = makeLeague({ status: "provisioning" });
    const membership = makeMembership({ role: "commissioner" });
    const result = authorizeLeagueAccess({ league, membership });
    expect(result).toEqual({ kind: "not_active" });
  });

  it("rejects an errored league", () => {
    const league = makeLeague({ status: "error" });
    const membership = makeMembership();
    const result = authorizeLeagueAccess({ league, membership });
    expect(result).toEqual({ kind: "not_active" });
  });

  it("authorizes a member of an active league with isOwner false", () => {
    const league = makeLeague({ status: "active" });
    const membership = makeMembership({ role: "member" });
    const result = authorizeLeagueAccess({ league, membership });
    expect(result).toEqual({ kind: "authorized", isOwner: false });
  });

  it("authorizes the commissioner of an active league with isOwner true", () => {
    const league = makeLeague({ status: "active" });
    const membership = makeMembership({ role: "commissioner" });
    const result = authorizeLeagueAccess({ league, membership });
    expect(result).toEqual({ kind: "authorized", isOwner: true });
  });
});
