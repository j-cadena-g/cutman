/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { activateLeague, ensureSchema, getLeagueBySleeperId, upsertUserByClerkId } from "@cutman/db";
import type { NflState, SleeperClient, SleeperLeague, SleeperLeagueUser, SleeperUser } from "@cutman/sleeper";
import { beforeAll, describe, expect, it } from "vitest";
import {
  connectSleeperAccount,
  createChallengeCode,
  discoverLeagues,
  joinPilotLeague,
  requestCommissionerChallenge,
  verifyCommissionerChallenge,
  type OnboardingDeps,
} from "../app/lib/onboarding.server.ts";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

const PILOT_LEAGUE_ID = "sleeper_pilot_league";
const OTHER_LEAGUE_ID = "sleeper_other_league";

type FakeSleeperConfig = {
  usersByLookup?: Record<string, SleeperUser>;
  nflState?: NflState;
  userLeagues?: Record<string, SleeperLeague[]>;
  leagueUsersById?: Record<string, SleeperLeagueUser[]>;
  leaguesById?: Record<string, SleeperLeague>;
};

// A fully explicit, per-league-controllable Sleeper test double. Unlike the shared package
// fixture client (which serves the same single league/users list for any matching league id),
// this lets each test independently control ownership/membership per league id, which the
// "derived per-league, not insertion order" requirement specifically needs to exercise.
function createFakeSleeperClient(config: FakeSleeperConfig): SleeperClient & { calls: { getUser: number } } {
  const calls = { getUser: 0 };
  return {
    calls,
    async getNflState() {
      return config.nflState ?? { week: 1, season_type: "regular", season: "2026", league_season: "2026" };
    },
    async getUser(usernameOrId) {
      calls.getUser += 1;
      return config.usersByLookup?.[usernameOrId] ?? null;
    },
    async getUserLeagues(userId) {
      return config.userLeagues?.[userId] ?? [];
    },
    async getLeague(leagueId) {
      return config.leaguesById?.[leagueId] ?? null;
    },
    async getLeagueUsers(leagueId) {
      return config.leagueUsersById?.[leagueId] ?? [];
    },
    async getRosters() {
      return [];
    },
    async getMatchups() {
      return [];
    },
    async getTransactions() {
      return [];
    },
    async getPlayers() {
      return {};
    },
  };
}

// Module-level (not per-`makeDeps`-call) so ids/challenges stay unique across every test in this
// file, since they all share one D1 instance for the duration of the file's run.
let challengeCounter = 0;
let idCounter = 0;

function makeDeps(overrides: Partial<OnboardingDeps> & { sleeperClient: SleeperClient }): OnboardingDeps {
  const defaultNow = 1_800_000_000_000;
  return {
    db: env.DB,
    pilotSleeperLeagueId: PILOT_LEAGUE_ID,
    now: () => defaultNow,
    generateChallenge: () => `CUTMAN-TEST${challengeCounter++}`,
    generateId: () => `verification_${idCounter++}`,
    challengeTtlMs: 15 * 60 * 1000,
    ...overrides,
  };
}

async function seedUser(id: string, email: string) {
  await ensureSchema(env.DB);
  return upsertUserByClerkId(env.DB, { id, email, now: Date.now() });
}

describe("createChallengeCode", () => {
  it("produces CUTMAN- followed by 4 unambiguous uppercase letters/digits", () => {
    for (let i = 0; i < 200; i++) {
      const code = createChallengeCode();
      expect(code).toMatch(/^CUTMAN-[A-Z0-9]{4}$/);
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it("is deterministic when given an injected random source", () => {
    const random = () => 0;
    expect(createChallengeCode(random)).toBe(createChallengeCode(random));
  });
});

describe("connectSleeperAccount", () => {
  it("trims the username, resolves it via SleeperClient, and links the stable Sleeper user id", async () => {
    const user = await seedUser("user_connect_1", "connect1@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_commish", username: "commish", display_name: "Commish" } },
    });
    const deps = makeDeps({ sleeperClient });

    const result = await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: "  commish  " });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.wasNewLink).toBe(true);
    expect(result.account.sleeper_user_id).toBe("sleeper_commish");
    expect(result.account.username).toBe("commish");
    expect(result.account.display_name).toBe("Commish");
  });

  it("rejects blank/whitespace-only usernames without calling SleeperClient", async () => {
    const user = await seedUser("user_connect_2", "connect2@example.test");
    const sleeperClient = createFakeSleeperClient({});
    const deps = makeDeps({ sleeperClient });

    const result = await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: "   " });

    expect(result).toEqual({ ok: false, error: { kind: "invalid_username" } });
    expect(sleeperClient.calls.getUser).toBe(0);
  });

  it("returns sleeper_user_not_found when Sleeper has no matching account", async () => {
    const user = await seedUser("user_connect_3", "connect3@example.test");
    const sleeperClient = createFakeSleeperClient({ usersByLookup: {} });
    const deps = makeDeps({ sleeperClient });

    const result = await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: "ghost" });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_user_not_found", username: "ghost" } });
  });

  it("refreshes mutable username/display name on reconnect without changing the stable Sleeper user id", async () => {
    const user = await seedUser("user_connect_4", "connect4@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_commish_4", username: "commish", display_name: "Commish" } },
    });
    const deps = makeDeps({ sleeperClient });
    await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: "commish" });

    const renamedClient = createFakeSleeperClient({
      usersByLookup: {
        commish_new_handle: {
          user_id: "sleeper_commish_4",
          username: "commish_new_handle",
          display_name: "Commish New Handle",
        },
      },
    });
    const result = await connectSleeperAccount(makeDeps({ sleeperClient: renamedClient }), {
      clerkUserId: user.id,
      usernameInput: "commish_new_handle",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.wasNewLink).toBe(false);
    expect(result.account.sleeper_user_id).toBe("sleeper_commish_4");
    expect(result.account.username).toBe("commish_new_handle");
    expect(result.account.display_name).toBe("Commish New Handle");
  });

  it("rejects connecting a Sleeper account already connected to a different Clerk user", async () => {
    const owner = await seedUser("user_connect_5a", "connect5a@example.test");
    const other = await seedUser("user_connect_5b", "connect5b@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { shared: { user_id: "sleeper_shared", username: "shared", display_name: "Shared" } },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: owner.id, usernameInput: "shared" });

    const result = await connectSleeperAccount(makeDeps({ sleeperClient }), {
      clerkUserId: other.id,
      usernameInput: "shared",
    });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_connected_to_another_user" } });
  });

  it("rejects switching a Clerk user's connection to a different stable Sleeper identity", async () => {
    const user = await seedUser("user_connect_6", "connect6@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: {
        first: { user_id: "sleeper_first", username: "first", display_name: "First" },
        second: { user_id: "sleeper_second", username: "second", display_name: "Second" },
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "first" });

    const result = await connectSleeperAccount(makeDeps({ sleeperClient }), {
      clerkUserId: user.id,
      usernameInput: "second",
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: "clerk_user_already_connected_to_different_sleeper_account", existingSleeperUserId: "sleeper_first" },
    });
  });
});

describe("discoverLeagues", () => {
  it("errors when the Clerk user has not linked a Sleeper account", async () => {
    const user = await seedUser("user_discover_1", "discover1@example.test");
    const deps = makeDeps({ sleeperClient: createFakeSleeperClient({}) });

    const result = await discoverLeagues(deps, { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_not_linked" } });
  });

  it("classifies the configured pilot league as pilot and every other league as coming_soon", async () => {
    const user = await seedUser("user_discover_2", "discover2@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { scout: { user_id: "sleeper_scout", username: "scout", display_name: "Scout" } },
      userLeagues: {
        sleeper_scout: [
          { league_id: PILOT_LEAGUE_ID, name: "The Pilot", season: "2026", sport: "nfl" },
          { league_id: OTHER_LEAGUE_ID, name: "Someday League", season: "2026", sport: "nfl" },
        ],
      },
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [{ user_id: "sleeper_scout", username: "scout", display_name: "Scout", is_owner: false }],
        [OTHER_LEAGUE_ID]: [{ user_id: "sleeper_scout", username: "scout", display_name: "Scout", is_owner: true }],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "scout" });

    const result = await discoverLeagues(makeDeps({ sleeperClient }), { clerkUserId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.season).toBe("2026");
    const byId = new Map(result.leagues.map((league) => [league.sleeperLeagueId, league]));
    expect(byId.get(PILOT_LEAGUE_ID)?.classification).toBe("pilot");
    expect(byId.get(OTHER_LEAGUE_ID)?.classification).toBe("coming_soon");
  });

  it("derives isOwner independently per league from getLeagueUsers, not from discovery order", async () => {
    const user = await seedUser("user_discover_3", "discover3@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { scout: { user_id: "sleeper_scout_3", username: "scout", display_name: "Scout" } },
      userLeagues: {
        sleeper_scout_3: [
          { league_id: PILOT_LEAGUE_ID, name: "The Pilot", season: "2026", sport: "nfl" },
          { league_id: OTHER_LEAGUE_ID, name: "Someday League", season: "2026", sport: "nfl" },
        ],
      },
      // The connected user is listed FIRST (i.e. "inserted first") in the other league but is
      // NOT the owner there, and is listed LAST in the pilot league but IS the owner there. If
      // ownership were ever inferred from insertion order this would get it backwards.
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          { user_id: "sleeper_someone_else", username: "someone", display_name: "Someone", is_owner: false },
          { user_id: "sleeper_scout_3", username: "scout", display_name: "Scout", is_owner: true },
        ],
        [OTHER_LEAGUE_ID]: [
          { user_id: "sleeper_scout_3", username: "scout", display_name: "Scout", is_owner: false },
          { user_id: "sleeper_someone_else", username: "someone", display_name: "Someone", is_owner: true },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "scout" });

    const result = await discoverLeagues(makeDeps({ sleeperClient }), { clerkUserId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const byId = new Map(result.leagues.map((league) => [league.sleeperLeagueId, league]));
    expect(byId.get(PILOT_LEAGUE_ID)?.isOwner).toBe(true);
    expect(byId.get(OTHER_LEAGUE_ID)?.isOwner).toBe(false);
  });
});

describe("requestCommissionerChallenge", () => {
  it("errors when no Sleeper account is linked", async () => {
    const user = await seedUser("user_challenge_1", "challenge1@example.test");
    const deps = makeDeps({ sleeperClient: createFakeSleeperClient({}) });

    const result = await requestCommissionerChallenge(deps, { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_not_linked" } });
  });

  it("errors when the linked Sleeper user is not a member of the pilot league", async () => {
    const user = await seedUser("user_challenge_2", "challenge2@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_commish_2", username: "commish", display_name: "Commish" } },
      leagueUsersById: { [PILOT_LEAGUE_ID]: [] },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "commish" });

    const result = await requestCommissionerChallenge(makeDeps({ sleeperClient }), { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "not_a_pilot_league_member" } });
  });

  it("errors when the linked Sleeper user is a league member but not the owner", async () => {
    const user = await seedUser("user_challenge_3", "challenge3@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_commish_3", username: "commish", display_name: "Commish" } },
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          { user_id: "sleeper_commish_3", username: "commish", display_name: "Commish", is_owner: false },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "commish" });

    const result = await requestCommissionerChallenge(makeDeps({ sleeperClient }), { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "not_owner" } });
  });

  it("issues a CUTMAN-XXXX challenge that expires 15 minutes from now for a current owner", async () => {
    const user = await seedUser("user_challenge_4", "challenge4@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: {
        commish: { user_id: "sleeper_commish_challenge_4", username: "commish", display_name: "Commish" },
      },
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          { user_id: "sleeper_commish_challenge_4", username: "commish", display_name: "Commish", is_owner: true },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "commish" });
    const now = 1_800_500_000_000;

    const result = await requestCommissionerChallenge(makeDeps({ sleeperClient, now: () => now }), {
      clerkUserId: user.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.challenge).toMatch(/^CUTMAN-/);
    expect(result.expiresAt).toBe(now + 15 * 60 * 1000);
  });
});

describe("verifyCommissionerChallenge", () => {
  async function setupOwner(input: {
    clerkUserId: string;
    email: string;
    sleeperUserId: string;
    username: string;
    teamName: string;
    isOwner: boolean;
    requestNow: number;
  }) {
    const user = await seedUser(input.clerkUserId, input.email);
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: {
        [input.username]: { user_id: input.sleeperUserId, username: input.username, display_name: input.username },
      },
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          {
            user_id: input.sleeperUserId,
            username: input.username,
            display_name: input.username,
            is_owner: input.isOwner,
            metadata: { team_name: input.teamName },
          },
        ],
      },
      leaguesById: {
        [PILOT_LEAGUE_ID]: { league_id: PILOT_LEAGUE_ID, name: "The Pilot", season: "2026", sport: "nfl" },
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), {
      clerkUserId: user.id,
      usernameInput: input.username,
    });
    const requested = await requestCommissionerChallenge(makeDeps({ sleeperClient, now: () => input.requestNow }), {
      clerkUserId: user.id,
    });
    if (!requested.ok) throw new Error("setup expected a successful challenge request");
    return { user, sleeperClient, requested };
  }

  it("errors when there is no pending challenge", async () => {
    const user = await seedUser("user_verify_onboard_1", "verify-onboard1@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_v1", username: "commish", display_name: "Commish" } },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "commish" });

    const result = await verifyCommissionerChallenge(makeDeps({ sleeperClient }), { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "no_pending_challenge" } });
  });

  it("expires a challenge past its 15 minute TTL and rejects verification instead of just incrementing attempts", async () => {
    const requestNow = 1_801_000_000_000;
    const { user, sleeperClient } = await setupOwner({
      clerkUserId: "user_verify_onboard_2",
      email: "verify-onboard2@example.test",
      sleeperUserId: "sleeper_v2",
      username: "commish2",
      teamName: "Doesn't matter",
      isOwner: true,
      requestNow,
    });

    const pastTtl = requestNow + 15 * 60 * 1000 + 1;
    const result = await verifyCommissionerChallenge(makeDeps({ sleeperClient, now: () => pastTtl }), {
      clerkUserId: user.id,
    });

    expect(result).toEqual({ ok: false, error: { kind: "challenge_expired" } });
  });

  it("increments attempts and rejects when the challenge is not present in the team name", async () => {
    const requestNow = 1_801_100_000_000;
    const { user, sleeperClient } = await setupOwner({
      clerkUserId: "user_verify_onboard_3",
      email: "verify-onboard3@example.test",
      sleeperUserId: "sleeper_v3",
      username: "commish3",
      teamName: "Just A Normal Team Name",
      isOwner: true,
      requestNow,
    });

    const soon = requestNow + 1000;
    const result = await verifyCommissionerChallenge(makeDeps({ sleeperClient, now: () => soon }), {
      clerkUserId: user.id,
    });

    expect(result).toEqual({ ok: false, error: { kind: "challenge_not_found_in_team_name" } });
  });

  it("rejects and increments attempts when Sleeper ownership was revoked since the challenge was requested", async () => {
    const requestNow = 1_801_200_000_000;
    const { user, requested } = await setupOwner({
      clerkUserId: "user_verify_onboard_4",
      email: "verify-onboard4@example.test",
      sleeperUserId: "sleeper_v4",
      username: "commish4",
      teamName: "whatever",
      isOwner: true,
      requestNow,
    });
    // Ownership flips to false on Sleeper's side between requesting and verifying the challenge.
    const revokedClient = createFakeSleeperClient({
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          {
            user_id: "sleeper_v4",
            username: "commish4",
            display_name: "commish4",
            is_owner: false,
            metadata: { team_name: `Team ${requested.challenge}` },
          },
        ],
      },
    });

    const result = await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: revokedClient, now: () => requestNow + 1000 }),
      { clerkUserId: user.id },
    );

    expect(result).toEqual({ ok: false, error: { kind: "not_owner" } });
  });

  it("accepts a case-insensitive challenge match, consumes it once, creates the league in provisioning, and writes commissioner membership", async () => {
    const requestNow = 1_801_300_000_000;
    const { user, requested } = await setupOwner({
      clerkUserId: "user_verify_onboard_5",
      email: "verify-onboard5@example.test",
      sleeperUserId: "sleeper_v5",
      username: "commish5",
      teamName: "placeholder, replaced below with the real challenge",
      isOwner: true,
      requestNow,
    });
    // The team name is set on Sleeper's side *after* the challenge is issued, using whatever
    // case the user typed. Uses a different case than the generated challenge to prove the
    // team-name match is case-insensitive.
    const matchingClient = createFakeSleeperClient({
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          {
            user_id: "sleeper_v5",
            username: "commish5",
            display_name: "commish5",
            is_owner: true,
            metadata: { team_name: `The ${requested.challenge.toLowerCase()} Dynasty` },
          },
        ],
      },
      leaguesById: {
        [PILOT_LEAGUE_ID]: { league_id: PILOT_LEAGUE_ID, name: "The Pilot", season: "2026", sport: "nfl" },
      },
    });

    const verifyNow = requestNow + 1000;
    const result = await verifyCommissionerChallenge(makeDeps({ sleeperClient: matchingClient, now: () => verifyNow }), {
      clerkUserId: user.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.sleeper_league_id).toBe(PILOT_LEAGUE_ID);
    expect(result.league.status).toBe("provisioning");
    expect(result.membership.role).toBe("commissioner");

    const stored = await getLeagueBySleeperId(env.DB, PILOT_LEAGUE_ID);
    expect(stored?.status).toBe("provisioning");

    // The same challenge cannot be replayed.
    const replay = await verifyCommissionerChallenge(makeDeps({ sleeperClient: matchingClient, now: () => verifyNow + 10 }), {
      clerkUserId: user.id,
    });
    expect(replay).toEqual({ ok: false, error: { kind: "no_pending_challenge" } });
  });
});

describe("joinPilotLeague", () => {
  it("errors when no Sleeper account is linked", async () => {
    const user = await seedUser("user_join_1", "join1@example.test");
    const deps = makeDeps({ sleeperClient: createFakeSleeperClient({}) });

    const result = await joinPilotLeague(deps, { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_not_linked" } });
  });

  it("errors when the pilot league is not active yet", async () => {
    const user = await seedUser("user_join_2", "join2@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { member: { user_id: "sleeper_member_2", username: "member", display_name: "Member" } },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "member" });

    const result = await joinPilotLeague(makeDeps({ sleeperClient }), { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "pilot_league_not_active" } });
  });

  it("errors when the linked Sleeper user is not a member of the (now active) pilot league", async () => {
    const requestNow = 1_802_000_000_000;
    const { sleeperClient: commishClient } = await verifyOwnerAndActivate({
      requestNow,
      commishClerkId: "user_join_commish_3",
    });
    const user = await seedUser("user_join_3", "join3@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { outsider: { user_id: "sleeper_outsider_3", username: "outsider", display_name: "Outsider" } },
      leagueUsersById: { [PILOT_LEAGUE_ID]: [] },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "outsider" });
    void commishClient;

    const result = await joinPilotLeague(makeDeps({ sleeperClient }), { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "not_a_pilot_league_member" } });
  });

  it("grants an explicit member role to a first-time joiner of an active pilot league", async () => {
    const requestNow = 1_802_100_000_000;
    await verifyOwnerAndActivate({ requestNow, commishClerkId: "user_join_commish_4" });

    const user = await seedUser("user_join_4", "join4@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { newbie: { user_id: "sleeper_newbie_4", username: "newbie", display_name: "Newbie" } },
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          { user_id: "sleeper_newbie_4", username: "newbie", display_name: "Newbie", is_owner: false },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), { clerkUserId: user.id, usernameInput: "newbie" });

    const result = await joinPilotLeague(makeDeps({ sleeperClient }), { clerkUserId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.membership.role).toBe("member");
  });

  it("never demotes an existing commissioner who joins again", async () => {
    const requestNow = 1_802_200_000_000;
    const { commishUser, sleeperClient } = await verifyOwnerAndActivate({
      requestNow,
      commishClerkId: "user_join_commish_5",
    });

    const result = await joinPilotLeague(makeDeps({ sleeperClient }), { clerkUserId: commishUser.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.membership.role).toBe("commissioner");
  });

  // Verifies a real commissioner challenge (so the pilot league row exists) and then activates
  // the league directly via the DB helper, since activation itself is out of this task's scope
  // (LeagueBrain provisioning owns that transition in a later task).
  async function verifyOwnerAndActivate(input: { requestNow: number; commishClerkId: string }) {
    const commishUser = await seedUser(input.commishClerkId, `${input.commishClerkId}@example.test`);
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { thecommish: { user_id: `sleeper_${input.commishClerkId}`, username: "thecommish", display_name: "The Commish" } },
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          {
            user_id: `sleeper_${input.commishClerkId}`,
            username: "thecommish",
            display_name: "The Commish",
            is_owner: true,
            metadata: { team_name: "will be set below" },
          },
        ],
      },
      leaguesById: {
        [PILOT_LEAGUE_ID]: { league_id: PILOT_LEAGUE_ID, name: "The Pilot", season: "2026", sport: "nfl" },
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient }), {
      clerkUserId: commishUser.id,
      usernameInput: "thecommish",
    });
    const requested = await requestCommissionerChallenge(makeDeps({ sleeperClient, now: () => input.requestNow }), {
      clerkUserId: commishUser.id,
    });
    if (!requested.ok) throw new Error("expected challenge request to succeed");
    const matchingClient = createFakeSleeperClient({
      leagueUsersById: {
        [PILOT_LEAGUE_ID]: [
          {
            user_id: `sleeper_${input.commishClerkId}`,
            username: "thecommish",
            display_name: "The Commish",
            is_owner: true,
            metadata: { team_name: `Team ${requested.challenge}` },
          },
        ],
      },
      leaguesById: {
        [PILOT_LEAGUE_ID]: { league_id: PILOT_LEAGUE_ID, name: "The Pilot", season: "2026", sport: "nfl" },
      },
    });
    const verified = await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: matchingClient, now: () => input.requestNow + 10 }),
      { clerkUserId: commishUser.id },
    );
    if (!verified.ok) throw new Error("expected verification to succeed");
    // The pilot league is shared (same internal id) across every test in this describe block, so
    // a prior test may have already activated it — activation itself is out of this task's
    // scope, this only needs the league to end up "active" once.
    if (verified.league.status !== "active") {
      await activateLeague(env.DB, verified.league.id, input.requestNow + 20);
    }
    return { commishUser, sleeperClient, verified };
  }
});
