import type { LeagueMemberRow, LeagueRow } from "@cutman/db";
import { describe, expect, it } from "vitest";
import {
  computePilotLeagueStep,
  describeOnboardingError,
  type OnboardingErrorKind,
} from "../app/lib/onboarding-view.ts";

function makeLeague(overrides: Partial<LeagueRow> = {}): LeagueRow {
  return {
    id: "pilot_league",
    sleeper_league_id: "pilot_league",
    name: "The Pilot",
    season: "2026",
    status: "provisioning",
    tone: "playful",
    created_at: 0,
    activated_at: null,
    provisioning_error: null,
    ...overrides,
  };
}

function makeMembership(overrides: Partial<LeagueMemberRow> = {}): LeagueMemberRow {
  return {
    league_id: "pilot_league",
    user_id: "user_1",
    role: "member",
    recap_email_opt_in: 0,
    created_at: 0,
    ...overrides,
  };
}

describe("computePilotLeagueStep", () => {
  it("asks to connect a Sleeper account first, regardless of any other input", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: false,
      pilotEntry: { isOwner: true },
      league: makeLeague({ status: "active" }),
      membership: makeMembership(),
      pendingVerification: { challenge: "CUTMAN-ABCD", expiresAt: 1, attempts: 0 },
    });
    expect(result).toEqual({ kind: "connect_sleeper_account" });
  });

  it("shows provisioning (setup in progress) once a league row exists, even for its own verified commissioner", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: { isOwner: true },
      league: makeLeague({ status: "provisioning" }),
      membership: makeMembership({ role: "commissioner" }),
      pendingVerification: null,
    });
    expect(result).toEqual({ kind: "provisioning" });
  });

  it("shows already_member once the league is active and this user already has a membership row", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: { isOwner: false },
      league: makeLeague({ status: "active" }),
      membership: makeMembership({ role: "member" }),
      pendingVerification: null,
    });
    expect(result).toEqual({ kind: "already_member" });
  });

  it("reports not_a_pilot_league_member when the connected Sleeper account isn't in the pilot league", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: null,
      league: null,
      membership: null,
      pendingVerification: null,
    });
    expect(result).toEqual({ kind: "not_a_pilot_league_member" });
  });

  it("reports setup_error when the pilot league failed provisioning", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: { isOwner: false },
      league: makeLeague({ status: "error" }),
      membership: null,
      pendingVerification: null,
    });
    expect(result).toEqual({ kind: "setup_error" });
  });

  it("reports provisioning when the league exists but isn't active yet and the user has no membership", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: { isOwner: false },
      league: makeLeague({ status: "provisioning" }),
      membership: null,
      pendingVerification: null,
    });
    expect(result).toEqual({ kind: "provisioning" });
  });

  it("reports join_available when the league is active and the user has no membership yet", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: { isOwner: false },
      league: makeLeague({ status: "active" }),
      membership: null,
      pendingVerification: null,
    });
    expect(result).toEqual({ kind: "join_available" });
  });

  it("reports challenge_pending with the challenge/expiry/attempts when a verification is outstanding", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: { isOwner: true },
      league: null,
      membership: null,
      pendingVerification: { challenge: "CUTMAN-WXYZ", expiresAt: 12345, attempts: 2 },
    });
    expect(result).toEqual({ kind: "challenge_pending", challenge: "CUTMAN-WXYZ", expiresAt: 12345, attempts: 2 });
  });

  it("reports request_challenge for a current Sleeper owner with no league and no pending challenge", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: { isOwner: true },
      league: null,
      membership: null,
      pendingVerification: null,
    });
    expect(result).toEqual({ kind: "request_challenge" });
  });

  it("reports awaiting_commissioner for a non-owner with no league yet and no pending challenge", () => {
    const result = computePilotLeagueStep({
      sleeperConnected: true,
      pilotEntry: { isOwner: false },
      league: null,
      membership: null,
      pendingVerification: null,
    });
    expect(result).toEqual({ kind: "awaiting_commissioner" });
  });
});

describe("describeOnboardingError", () => {
  const kinds: OnboardingErrorKind[] = [
    "invalid_username",
    "sleeper_user_not_found",
    "sleeper_account_connected_to_another_user",
    "clerk_user_already_connected_to_different_sleeper_account",
    "sleeper_account_not_linked",
    "not_a_pilot_league_member",
    "not_owner",
    "no_pending_challenge",
    "sleeper_account_mismatch",
    "challenge_expired",
    "challenge_not_found_in_team_name",
    "challenge_already_used",
    "pilot_league_not_found",
    "pilot_league_not_active",
  ];

  it("returns non-empty, distinct, plain-language copy for every error kind", () => {
    const messages = kinds.map((kind) => describeOnboardingError(kind));
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      // Never expose internal error/parse strings: no stack-trace-ish or raw-code markers.
      expect(message).not.toMatch(/error:|Error\]|D1_ERROR|TypeError|undefined|NaN/i);
    }
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("gives clear expiry guidance for an expired challenge", () => {
    expect(describeOnboardingError("challenge_expired")).toMatch(/15 minutes|expired/i);
  });

  it("gives a clear retry path when the team name doesn't contain the challenge yet", () => {
    expect(describeOnboardingError("challenge_not_found_in_team_name")).toMatch(/team name|rename/i);
  });
});
