/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import {
  activateLeague,
  consumeVerification,
  ensureSchema,
  findPendingVerification,
  getLeagueBySleeperId,
  getVerification,
  linkSleeperAccount,
  upsertUserByClerkId,
} from "@cutman/db";
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

// Every test gets its own pilot league id (see `nextPilotLeagueId` below) instead of sharing one
// module-level constant. This is what makes the file order-independent: no test's DB state
// (leagues, verifications, memberships) can be observed or mutated by any other test, so the
// suite passes identically under `--sequence.shuffle` or when any subset of tests is run in
// isolation. Only `OTHER_LEAGUE_ID` (a non-pilot "coming_soon" league) is shared — it is never
// persisted to D1 (discovered-but-not-pilot leagues aren't written anywhere), so reusing the
// literal id across tests carries no cross-test state.
const OTHER_LEAGUE_ID = "sleeper_other_league";

let pilotCounter = 0;
function nextPilotLeagueId(label: string): string {
  pilotCounter += 1;
  return `sleeper_pilot_${label}_${pilotCounter}`;
}

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

// `pilotSleeperLeagueId` has no default — every test must supply its own unique id (see
// `nextPilotLeagueId`), which is what keeps the suite order-independent.
function makeDeps(
  overrides: Partial<OnboardingDeps> & { sleeperClient: SleeperClient; pilotSleeperLeagueId: string },
): OnboardingDeps {
  const defaultNow = 1_800_000_000_000;
  return {
    db: env.DB,
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
  it("produces CUTMAN- followed by 4 unambiguous uppercase letters/digits, using the crypto-secure default", () => {
    for (let i = 0; i < 200; i++) {
      const code = createChallengeCode();
      expect(code).toMatch(/^CUTMAN-[A-Z0-9]{4}$/);
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it("varies across calls with the crypto-secure default (not a fixed/predictable value)", () => {
    const codes = new Set(Array.from({ length: 20 }, () => createChallengeCode()));
    expect(codes.size).toBeGreaterThan(1);
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
      usersByLookup: { commish: { user_id: "sleeper_commish_1", username: "commish", display_name: "Commish" } },
    });
    const deps = makeDeps({ sleeperClient, pilotSleeperLeagueId: nextPilotLeagueId("connect1") });

    const result = await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: "  commish  " });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.wasNewLink).toBe(true);
    expect(result.account.sleeper_user_id).toBe("sleeper_commish_1");
    expect(result.account.username).toBe("commish");
    expect(result.account.display_name).toBe("Commish");
  });

  it("rejects blank/whitespace-only usernames without calling SleeperClient", async () => {
    const user = await seedUser("user_connect_2", "connect2@example.test");
    const sleeperClient = createFakeSleeperClient({});
    const deps = makeDeps({ sleeperClient, pilotSleeperLeagueId: nextPilotLeagueId("connect2") });

    const result = await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: "   " });

    expect(result).toEqual({ ok: false, error: { kind: "invalid_username" } });
    expect(sleeperClient.calls.getUser).toBe(0);
  });

  it("returns sleeper_user_not_found when Sleeper has no matching account", async () => {
    const user = await seedUser("user_connect_3", "connect3@example.test");
    const sleeperClient = createFakeSleeperClient({ usersByLookup: {} });
    const deps = makeDeps({ sleeperClient, pilotSleeperLeagueId: nextPilotLeagueId("connect3") });

    const result = await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: "ghost" });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_user_not_found", username: "ghost" } });
  });

  it("refreshes mutable username/display name on reconnect without changing the stable Sleeper user id", async () => {
    const user = await seedUser("user_connect_4", "connect4@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("connect4");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_commish_4", username: "commish", display_name: "Commish" } },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "commish",
    });

    const renamedClient = createFakeSleeperClient({
      usersByLookup: {
        commish_new_handle: {
          user_id: "sleeper_commish_4",
          username: "commish_new_handle",
          display_name: "Commish New Handle",
        },
      },
    });
    const result = await connectSleeperAccount(makeDeps({ sleeperClient: renamedClient, pilotSleeperLeagueId }), {
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
    const pilotSleeperLeagueId = nextPilotLeagueId("connect5");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { shared: { user_id: "sleeper_shared_5", username: "shared", display_name: "Shared" } },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: owner.id,
      usernameInput: "shared",
    });

    const result = await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: other.id,
      usernameInput: "shared",
    });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_connected_to_another_user" } });
  });

  it("rejects switching a Clerk user's connection to a different stable Sleeper identity", async () => {
    const user = await seedUser("user_connect_6", "connect6@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("connect6");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: {
        first: { user_id: "sleeper_first_6", username: "first", display_name: "First" },
        second: { user_id: "sleeper_second_6", username: "second", display_name: "Second" },
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "first",
    });

    const result = await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "second",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "clerk_user_already_connected_to_different_sleeper_account",
        existingSleeperUserId: "sleeper_first_6",
      },
    });
  });

  it("resolves a concurrent same-Sleeper-account link race without throwing: exactly one link wins, the other is rejected", async () => {
    const userA = await seedUser("user_connect_race_a", "connect-race-a@example.test");
    const userB = await seedUser("user_connect_race_b", "connect-race-b@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("connect_race");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { racer: { user_id: "sleeper_race_shared", username: "racer", display_name: "Racer" } },
    });

    const [resultA, resultB] = await Promise.all([
      connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
        clerkUserId: userA.id,
        usernameInput: "racer",
      }),
      connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
        clerkUserId: userB.id,
        usernameInput: "racer",
      }),
    ]);

    // Neither call throws — that is the point of the fix. Regardless of which request's insert
    // physically wins the race, exactly one resolves ok and the other is rejected as already
    // connected to a different Clerk user (never a raw D1 constraint error).
    const results = [resultA, resultB];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const rejected = results.filter((r) => !r.ok);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ ok: false, error: { kind: "sleeper_account_connected_to_another_user" } });
  });
});

describe("discoverLeagues", () => {
  it("errors when the Clerk user has not linked a Sleeper account", async () => {
    const user = await seedUser("user_discover_1", "discover1@example.test");
    const deps = makeDeps({ sleeperClient: createFakeSleeperClient({}), pilotSleeperLeagueId: nextPilotLeagueId("discover1") });

    const result = await discoverLeagues(deps, { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_not_linked" } });
  });

  it("classifies the configured pilot league as pilot and every other league as coming_soon", async () => {
    const user = await seedUser("user_discover_2", "discover2@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("discover2");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { scout: { user_id: "sleeper_scout_2", username: "scout", display_name: "Scout" } },
      userLeagues: {
        sleeper_scout_2: [
          { league_id: pilotSleeperLeagueId, name: "The Pilot", season: "2026", sport: "nfl" },
          { league_id: OTHER_LEAGUE_ID, name: "Someday League", season: "2026", sport: "nfl" },
        ],
      },
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          { user_id: "sleeper_scout_2", username: "scout", display_name: "Scout", is_owner: false },
        ],
        [OTHER_LEAGUE_ID]: [
          { user_id: "sleeper_scout_2", username: "scout", display_name: "Scout", is_owner: true },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "scout",
    });

    const result = await discoverLeagues(makeDeps({ sleeperClient, pilotSleeperLeagueId }), { clerkUserId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.season).toBe("2026");
    const byId = new Map(result.leagues.map((league) => [league.sleeperLeagueId, league]));
    expect(byId.get(pilotSleeperLeagueId)?.classification).toBe("pilot");
    expect(byId.get(OTHER_LEAGUE_ID)?.classification).toBe("coming_soon");
  });

  it("derives isOwner independently per league from getLeagueUsers, not from discovery order", async () => {
    const user = await seedUser("user_discover_3", "discover3@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("discover3");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { scout: { user_id: "sleeper_scout_3", username: "scout", display_name: "Scout" } },
      userLeagues: {
        sleeper_scout_3: [
          { league_id: pilotSleeperLeagueId, name: "The Pilot", season: "2026", sport: "nfl" },
          { league_id: OTHER_LEAGUE_ID, name: "Someday League", season: "2026", sport: "nfl" },
        ],
      },
      // The connected user is listed FIRST (i.e. "inserted first") in the other league but is
      // NOT the owner there, and is listed LAST in the pilot league but IS the owner there. If
      // ownership were ever inferred from insertion order this would get it backwards.
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          { user_id: "sleeper_someone_else_3", username: "someone", display_name: "Someone", is_owner: false },
          { user_id: "sleeper_scout_3", username: "scout", display_name: "Scout", is_owner: true },
        ],
        [OTHER_LEAGUE_ID]: [
          { user_id: "sleeper_scout_3", username: "scout", display_name: "Scout", is_owner: false },
          { user_id: "sleeper_someone_else_3", username: "someone", display_name: "Someone", is_owner: true },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "scout",
    });

    const result = await discoverLeagues(makeDeps({ sleeperClient, pilotSleeperLeagueId }), { clerkUserId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const byId = new Map(result.leagues.map((league) => [league.sleeperLeagueId, league]));
    expect(byId.get(pilotSleeperLeagueId)?.isOwner).toBe(true);
    expect(byId.get(OTHER_LEAGUE_ID)?.isOwner).toBe(false);
  });

  it("fetches each league's roster sequentially (bounded), never more than one getLeagueUsers call in flight at once", async () => {
    const user = await seedUser("user_discover_4", "discover4@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("discover4");
    const otherLeagueIds = ["sleeper_bounded_a", "sleeper_bounded_b", "sleeper_bounded_c"];
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const sleeperClient: SleeperClient = {
      async getNflState() {
        return { week: 1, season_type: "regular", season: "2026", league_season: "2026" };
      },
      async getUser() {
        return { user_id: "sleeper_scout_4", username: "scout", display_name: "Scout" };
      },
      async getUserLeagues() {
        return [pilotSleeperLeagueId, ...otherLeagueIds].map((leagueId) => ({
          league_id: leagueId,
          name: leagueId,
          season: "2026",
          sport: "nfl",
        }));
      },
      async getLeague() {
        return null;
      },
      async getLeagueUsers(leagueId) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push(leagueId);
        await Promise.resolve();
        inFlight -= 1;
        return [{ user_id: "sleeper_scout_4", username: "scout", display_name: "Scout", is_owner: false }];
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
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "scout",
    });

    const result = await discoverLeagues(makeDeps({ sleeperClient, pilotSleeperLeagueId }), { clerkUserId: user.id });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(calls).toEqual([pilotSleeperLeagueId, ...otherLeagueIds]);
  });
});

describe("requestCommissionerChallenge", () => {
  it("errors when no Sleeper account is linked", async () => {
    const user = await seedUser("user_challenge_1", "challenge1@example.test");
    const deps = makeDeps({ sleeperClient: createFakeSleeperClient({}), pilotSleeperLeagueId: nextPilotLeagueId("challenge1") });

    const result = await requestCommissionerChallenge(deps, { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_not_linked" } });
  });

  it("errors when the linked Sleeper user is not a member of the pilot league", async () => {
    const user = await seedUser("user_challenge_2", "challenge2@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("challenge2");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_commish_2", username: "commish", display_name: "Commish" } },
      leagueUsersById: { [pilotSleeperLeagueId]: [] },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "commish",
    });

    const result = await requestCommissionerChallenge(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
    });

    expect(result).toEqual({ ok: false, error: { kind: "not_a_pilot_league_member" } });
  });

  it("errors when the linked Sleeper user is a league member but not the owner", async () => {
    const user = await seedUser("user_challenge_3", "challenge3@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("challenge3");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_commish_3", username: "commish", display_name: "Commish" } },
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          { user_id: "sleeper_commish_3", username: "commish", display_name: "Commish", is_owner: false },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "commish",
    });

    const result = await requestCommissionerChallenge(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
    });

    expect(result).toEqual({ ok: false, error: { kind: "not_owner" } });
  });

  it("issues a CUTMAN-XXXX challenge that expires 15 minutes from now for a current owner", async () => {
    const user = await seedUser("user_challenge_4", "challenge4@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("challenge4");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: {
        commish: { user_id: "sleeper_commish_challenge_4", username: "commish", display_name: "Commish" },
      },
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          { user_id: "sleeper_commish_challenge_4", username: "commish", display_name: "Commish", is_owner: true },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "commish",
    });
    const now = 1_800_500_000_000;

    const result = await requestCommissionerChallenge(makeDeps({ sleeperClient, pilotSleeperLeagueId, now: () => now }), {
      clerkUserId: user.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.challenge).toMatch(/^CUTMAN-/);
    expect(result.expiresAt).toBe(now + 15 * 60 * 1000);
  });

  it("supersedes (expires) a prior pending challenge and carries its attempts forward instead of resetting to zero", async () => {
    const user = await seedUser("user_challenge_5", "challenge5@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("challenge5");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: {
        commish: { user_id: "sleeper_commish_5", username: "commish", display_name: "Commish" },
      },
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          { user_id: "sleeper_commish_5", username: "commish", display_name: "Commish", is_owner: true },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "commish",
    });
    const firstRequestNow = 1_800_600_000_000;
    const first = await requestCommissionerChallenge(
      makeDeps({ sleeperClient, pilotSleeperLeagueId, now: () => firstRequestNow }),
      { clerkUserId: user.id },
    );
    if (!first.ok) throw new Error("expected first challenge request to succeed");

    // Two wrong-guess verifies against the first challenge before it's superseded.
    const wrongTeamNameClient = createFakeSleeperClient({
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          {
            user_id: "sleeper_commish_5",
            username: "commish",
            display_name: "Commish",
            is_owner: true,
            metadata: { team_name: "Not the challenge" },
          },
        ],
      },
    });
    await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: wrongTeamNameClient, pilotSleeperLeagueId, now: () => firstRequestNow + 10 }),
      { clerkUserId: user.id },
    );
    await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: wrongTeamNameClient, pilotSleeperLeagueId, now: () => firstRequestNow + 20 }),
      { clerkUserId: user.id },
    );
    const afterAttempts = await getVerification(env.DB, first.verificationId);
    expect(afterAttempts?.attempts).toBe(2);

    const secondRequestNow = firstRequestNow + 30;
    const second = await requestCommissionerChallenge(
      makeDeps({ sleeperClient, pilotSleeperLeagueId, now: () => secondRequestNow }),
      { clerkUserId: user.id },
    );
    if (!second.ok) throw new Error("expected second challenge request to succeed");

    expect(second.verificationId).not.toBe(first.verificationId);
    const superseded = await getVerification(env.DB, first.verificationId);
    expect(superseded?.status).toBe("expired");
    const reissued = await getVerification(env.DB, second.verificationId);
    expect(reissued?.status).toBe("pending");
    expect(reissued?.attempts).toBe(2);

    // Exactly one pending verification exists for this user+league.
    const pending = await findPendingVerification(env.DB, { userId: user.id, sleeperLeagueId: pilotSleeperLeagueId });
    expect(pending?.id).toBe(second.verificationId);
  });
});

describe("verifyCommissionerChallenge", () => {
  async function setupOwner(input: {
    clerkUserId: string;
    email: string;
    pilotSleeperLeagueId: string;
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
        [input.pilotSleeperLeagueId]: [
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
        [input.pilotSleeperLeagueId]: {
          league_id: input.pilotSleeperLeagueId,
          name: "The Pilot",
          season: "2026",
          sport: "nfl",
        },
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId: input.pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: input.username,
    });
    const requested = await requestCommissionerChallenge(
      makeDeps({ sleeperClient, pilotSleeperLeagueId: input.pilotSleeperLeagueId, now: () => input.requestNow }),
      { clerkUserId: user.id },
    );
    if (!requested.ok) throw new Error("setup expected a successful challenge request");
    return { user, sleeperClient, requested };
  }

  it("errors when there is no pending challenge", async () => {
    const user = await seedUser("user_verify_onboard_1", "verify-onboard1@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("verify1");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { commish: { user_id: "sleeper_v1", username: "commish", display_name: "Commish" } },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "commish",
    });

    const result = await verifyCommissionerChallenge(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
    });

    expect(result).toEqual({ ok: false, error: { kind: "no_pending_challenge" } });
  });

  it("errors sleeper_account_mismatch when the connected Sleeper account changed since the challenge was requested", async () => {
    const pilotSleeperLeagueId = nextPilotLeagueId("verify_mismatch");
    const requestNow = 1_801_050_000_000;
    const { user, sleeperClient } = await setupOwner({
      clerkUserId: "user_verify_mismatch",
      email: "verify-mismatch@example.test",
      pilotSleeperLeagueId,
      sleeperUserId: "sleeper_mismatch_original",
      username: "commish_mismatch",
      teamName: "whatever",
      isOwner: true,
      requestNow,
    });

    // `connectSleeperAccount` deliberately never lets a Clerk user switch to a different stable
    // Sleeper identity once linked (see its own tests), so the only way the *currently connected*
    // account can differ from the one a pending verification was issued for is out-of-band — e.g.
    // a support/admin action relinking the row directly. Simulate exactly that precondition to
    // exercise this defense-in-depth check.
    await env.DB.prepare("UPDATE sleeper_accounts SET sleeper_user_id = ? WHERE user_id = ?")
      .bind("sleeper_mismatch_other", user.id)
      .run();

    const result = await verifyCommissionerChallenge(
      makeDeps({ sleeperClient, pilotSleeperLeagueId, now: () => requestNow + 1000 }),
      { clerkUserId: user.id },
    );

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_mismatch" } });
  });

  it("expires a challenge past its 15 minute TTL, persists it as expired, and rejects verification instead of incrementing attempts", async () => {
    const pilotSleeperLeagueId = nextPilotLeagueId("verify2");
    const requestNow = 1_801_000_000_000;
    const { user, sleeperClient, requested } = await setupOwner({
      clerkUserId: "user_verify_onboard_2",
      email: "verify-onboard2@example.test",
      pilotSleeperLeagueId,
      sleeperUserId: "sleeper_v2",
      username: "commish2",
      teamName: "Doesn't matter",
      isOwner: true,
      requestNow,
    });

    const pastTtl = requestNow + 15 * 60 * 1000 + 1;
    const result = await verifyCommissionerChallenge(makeDeps({ sleeperClient, pilotSleeperLeagueId, now: () => pastTtl }), {
      clerkUserId: user.id,
    });

    expect(result).toEqual({ ok: false, error: { kind: "challenge_expired" } });
    const persisted = await getVerification(env.DB, requested.verificationId);
    expect(persisted?.status).toBe("expired");
    expect(persisted?.attempts).toBe(0);
  });

  it("increments and persists attempts when the challenge is not present in the team name", async () => {
    const pilotSleeperLeagueId = nextPilotLeagueId("verify3");
    const requestNow = 1_801_100_000_000;
    const { user, sleeperClient, requested } = await setupOwner({
      clerkUserId: "user_verify_onboard_3",
      email: "verify-onboard3@example.test",
      pilotSleeperLeagueId,
      sleeperUserId: "sleeper_v3",
      username: "commish3",
      teamName: "Just A Normal Team Name",
      isOwner: true,
      requestNow,
    });

    const soon = requestNow + 1000;
    const result = await verifyCommissionerChallenge(makeDeps({ sleeperClient, pilotSleeperLeagueId, now: () => soon }), {
      clerkUserId: user.id,
    });

    expect(result).toEqual({ ok: false, error: { kind: "challenge_not_found_in_team_name" } });
    const persisted = await getVerification(env.DB, requested.verificationId);
    expect(persisted?.status).toBe("pending");
    expect(persisted?.attempts).toBe(1);

    // A second wrong guess increments again.
    await verifyCommissionerChallenge(makeDeps({ sleeperClient, pilotSleeperLeagueId, now: () => soon + 10 }), {
      clerkUserId: user.id,
    });
    const persistedAgain = await getVerification(env.DB, requested.verificationId);
    expect(persistedAgain?.attempts).toBe(2);
  });

  it("rejects and increments attempts when Sleeper ownership was revoked since the challenge was requested", async () => {
    const pilotSleeperLeagueId = nextPilotLeagueId("verify4");
    const requestNow = 1_801_200_000_000;
    const { user, requested } = await setupOwner({
      clerkUserId: "user_verify_onboard_4",
      email: "verify-onboard4@example.test",
      pilotSleeperLeagueId,
      sleeperUserId: "sleeper_v4",
      username: "commish4",
      teamName: "whatever",
      isOwner: true,
      requestNow,
    });
    // Ownership flips to false on Sleeper's side between requesting and verifying the challenge.
    const revokedClient = createFakeSleeperClient({
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
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
      makeDeps({ sleeperClient: revokedClient, pilotSleeperLeagueId, now: () => requestNow + 1000 }),
      { clerkUserId: user.id },
    );

    expect(result).toEqual({ ok: false, error: { kind: "not_owner" } });
    const persisted = await getVerification(env.DB, requested.verificationId);
    expect(persisted?.attempts).toBe(1);
  });

  it("accepts a case-insensitive challenge match, consumes it once, creates the league in provisioning, writes commissioner membership, and rejects replay", async () => {
    const pilotSleeperLeagueId = nextPilotLeagueId("verify5");
    const requestNow = 1_801_300_000_000;
    const { user, requested } = await setupOwner({
      clerkUserId: "user_verify_onboard_5",
      email: "verify-onboard5@example.test",
      pilotSleeperLeagueId,
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
        [pilotSleeperLeagueId]: [
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
        [pilotSleeperLeagueId]: { league_id: pilotSleeperLeagueId, name: "The Pilot", season: "2026", sport: "nfl" },
      },
    });

    const verifyNow = requestNow + 1000;
    const result = await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: matchingClient, pilotSleeperLeagueId, now: () => verifyNow }),
      { clerkUserId: user.id },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.sleeper_league_id).toBe(pilotSleeperLeagueId);
    expect(result.league.status).toBe("provisioning");
    expect(result.membership.role).toBe("commissioner");

    const stored = await getLeagueBySleeperId(env.DB, pilotSleeperLeagueId);
    expect(stored?.status).toBe("provisioning");
    const persistedVerification = await getVerification(env.DB, requested.verificationId);
    expect(persistedVerification?.status).toBe("verified");

    // The same challenge cannot be replayed: no pending verification remains for this user+league.
    const replay = await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: matchingClient, pilotSleeperLeagueId, now: () => verifyNow + 10 }),
      { clerkUserId: user.id },
    );
    expect(replay).toEqual({ ok: false, error: { kind: "no_pending_challenge" } });
  });

  it("errors pilot_league_not_found when Sleeper has no league for the configured pilot id", async () => {
    const pilotSleeperLeagueId = nextPilotLeagueId("verify_pilot_missing");
    const requestNow = 1_801_600_000_000;
    const { user, requested } = await setupOwner({
      clerkUserId: "user_verify_pilot_missing",
      email: "verify-pilot-missing@example.test",
      pilotSleeperLeagueId,
      sleeperUserId: "sleeper_pilot_missing",
      username: "commish_pilot_missing",
      teamName: "placeholder",
      isOwner: true,
      requestNow,
    });
    const matchingButMissingLeague = createFakeSleeperClient({
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          {
            user_id: "sleeper_pilot_missing",
            username: "commish_pilot_missing",
            display_name: "commish_pilot_missing",
            is_owner: true,
            metadata: { team_name: `Team ${requested.challenge}` },
          },
        ],
      },
    });

    const result = await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: matchingButMissingLeague, pilotSleeperLeagueId, now: () => requestNow + 1000 }),
      { clerkUserId: user.id },
    );

    expect(result).toEqual({ ok: false, error: { kind: "pilot_league_not_found" } });
    const persisted = await getVerification(env.DB, requested.verificationId);
    expect(persisted?.status).toBe("pending");
  });

  it("returns challenge_already_used (not a raw error) when a concurrent request consumes the verification first", async () => {
    const pilotSleeperLeagueId = nextPilotLeagueId("verify_cas_used");
    const requestNow = 1_801_400_000_000;
    const { user, sleeperClient, requested } = await setupOwner({
      clerkUserId: "user_verify_cas_used",
      email: "verify-cas-used@example.test",
      pilotSleeperLeagueId,
      sleeperUserId: "sleeper_cas_used",
      username: "commish_cas_used",
      teamName: `Team ${"placeholder"}`,
      isOwner: true,
      requestNow,
    });
    const verifyNow = requestNow + 500;
    // The team name is finalized to match the real challenge, and `getLeagueUsers` — awaited
    // partway through `verifyCommissionerChallenge`, after the pending/expiry checks but before
    // the actual `consumeVerification` CAS — simulates a concurrent request that already won the
    // race and consumed this exact verification first.
    const racingClient: SleeperClient = {
      ...sleeperClient,
      async getLeagueUsers(_leagueId) {
        await consumeVerification(env.DB, { id: requested.verificationId, now: verifyNow - 1 });
        return [
          {
            user_id: "sleeper_cas_used",
            username: "commish_cas_used",
            display_name: "commish_cas_used",
            is_owner: true,
            metadata: { team_name: `Team ${requested.challenge}` },
          },
        ];
      },
    };

    const result = await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: racingClient, pilotSleeperLeagueId, now: () => verifyNow }),
      { clerkUserId: user.id },
    );

    expect(result).toEqual({ ok: false, error: { kind: "challenge_already_used" } });
  });

  it("returns challenge_expired (not a raw error) when the verification expires in the gap before the consume CAS", async () => {
    const pilotSleeperLeagueId = nextPilotLeagueId("verify_cas_expired");
    const requestNow = 1_801_500_000_000;
    const { user, sleeperClient, requested } = await setupOwner({
      clerkUserId: "user_verify_cas_expired",
      email: "verify-cas-expired@example.test",
      pilotSleeperLeagueId,
      sleeperUserId: "sleeper_cas_expired",
      username: "commish_cas_expired",
      teamName: "placeholder",
      isOwner: true,
      requestNow,
    });
    const verifyNow = requestNow + 500;
    // Simulates the TTL lapsing (a concurrent process, or real wall-clock time in production)
    // strictly between this service's own expiry check and its `consumeVerification` CAS.
    const racingClient: SleeperClient = {
      ...sleeperClient,
      async getLeagueUsers(_leagueId) {
        await env.DB.prepare("UPDATE league_verifications SET expires_at = ? WHERE id = ? AND status = 'pending'")
          .bind(verifyNow - 1, requested.verificationId)
          .run();
        return [
          {
            user_id: "sleeper_cas_expired",
            username: "commish_cas_expired",
            display_name: "commish_cas_expired",
            is_owner: true,
            metadata: { team_name: `Team ${requested.challenge}` },
          },
        ];
      },
    };

    const result = await verifyCommissionerChallenge(
      makeDeps({ sleeperClient: racingClient, pilotSleeperLeagueId, now: () => verifyNow }),
      { clerkUserId: user.id },
    );

    expect(result).toEqual({ ok: false, error: { kind: "challenge_expired" } });
    const persisted = await getVerification(env.DB, requested.verificationId);
    expect(persisted?.status).toBe("expired");
  });
});

describe("joinPilotLeague", () => {
  it("errors when no Sleeper account is linked", async () => {
    const user = await seedUser("user_join_1", "join1@example.test");
    const deps = makeDeps({ sleeperClient: createFakeSleeperClient({}), pilotSleeperLeagueId: nextPilotLeagueId("join1") });

    const result = await joinPilotLeague(deps, { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "sleeper_account_not_linked" } });
  });

  it("errors when the pilot league is not active yet", async () => {
    const user = await seedUser("user_join_2", "join2@example.test");
    const pilotSleeperLeagueId = nextPilotLeagueId("join2");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { member: { user_id: "sleeper_member_2", username: "member", display_name: "Member" } },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "member",
    });

    const result = await joinPilotLeague(makeDeps({ sleeperClient, pilotSleeperLeagueId }), { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "pilot_league_not_active" } });
  });

  it("errors when the linked Sleeper user is not a member of the (now active) pilot league", async () => {
    const requestNow = 1_802_000_000_000;
    const pilotSleeperLeagueId = nextPilotLeagueId("join3");
    await verifyOwnerAndActivate({ requestNow, pilotSleeperLeagueId, commishClerkId: "user_join_commish_3" });
    const user = await seedUser("user_join_3", "join3@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { outsider: { user_id: "sleeper_outsider_3", username: "outsider", display_name: "Outsider" } },
      leagueUsersById: { [pilotSleeperLeagueId]: [] },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "outsider",
    });

    const result = await joinPilotLeague(makeDeps({ sleeperClient, pilotSleeperLeagueId }), { clerkUserId: user.id });

    expect(result).toEqual({ ok: false, error: { kind: "not_a_pilot_league_member" } });
  });

  it("grants an explicit member role to a first-time joiner of an active pilot league", async () => {
    const requestNow = 1_802_100_000_000;
    const pilotSleeperLeagueId = nextPilotLeagueId("join4");
    await verifyOwnerAndActivate({ requestNow, pilotSleeperLeagueId, commishClerkId: "user_join_commish_4" });

    const user = await seedUser("user_join_4", "join4@example.test");
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { newbie: { user_id: "sleeper_newbie_4", username: "newbie", display_name: "Newbie" } },
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          { user_id: "sleeper_newbie_4", username: "newbie", display_name: "Newbie", is_owner: false },
        ],
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: user.id,
      usernameInput: "newbie",
    });

    const result = await joinPilotLeague(makeDeps({ sleeperClient, pilotSleeperLeagueId }), { clerkUserId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.membership.role).toBe("member");
  });

  it("never demotes an existing commissioner who joins again", async () => {
    const requestNow = 1_802_200_000_000;
    const pilotSleeperLeagueId = nextPilotLeagueId("join5");
    const { commishUser, sleeperClient } = await verifyOwnerAndActivate({
      requestNow,
      pilotSleeperLeagueId,
      commishClerkId: "user_join_commish_5",
    });

    const result = await joinPilotLeague(makeDeps({ sleeperClient, pilotSleeperLeagueId }), {
      clerkUserId: commishUser.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.membership.role).toBe("commissioner");
  });

  // Verifies a real commissioner challenge (so the pilot league row exists) and then activates
  // the league directly via the DB helper, since activation itself is out of this task's scope
  // (LeagueBrain provisioning owns that transition in a later task). Each caller passes its own
  // unique `pilotSleeperLeagueId`, so this never shares a league with any other test.
  async function verifyOwnerAndActivate(input: { requestNow: number; pilotSleeperLeagueId: string; commishClerkId: string }) {
    const commishUser = await seedUser(input.commishClerkId, `${input.commishClerkId}@example.test`);
    const sleeperUserId = `sleeper_${input.commishClerkId}`;
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: { thecommish: { user_id: sleeperUserId, username: "thecommish", display_name: "The Commish" } },
      leagueUsersById: {
        [input.pilotSleeperLeagueId]: [
          {
            user_id: sleeperUserId,
            username: "thecommish",
            display_name: "The Commish",
            is_owner: true,
            metadata: { team_name: "will be set below" },
          },
        ],
      },
      leaguesById: {
        [input.pilotSleeperLeagueId]: {
          league_id: input.pilotSleeperLeagueId,
          name: "The Pilot",
          season: "2026",
          sport: "nfl",
        },
      },
    });
    await connectSleeperAccount(makeDeps({ sleeperClient, pilotSleeperLeagueId: input.pilotSleeperLeagueId }), {
      clerkUserId: commishUser.id,
      usernameInput: "thecommish",
    });
    const requested = await requestCommissionerChallenge(
      makeDeps({ sleeperClient, pilotSleeperLeagueId: input.pilotSleeperLeagueId, now: () => input.requestNow }),
      { clerkUserId: commishUser.id },
    );
    if (!requested.ok) throw new Error("expected challenge request to succeed");
    const matchingClient = createFakeSleeperClient({
      leagueUsersById: {
        [input.pilotSleeperLeagueId]: [
          {
            user_id: sleeperUserId,
            username: "thecommish",
            display_name: "The Commish",
            is_owner: true,
            metadata: { team_name: `Team ${requested.challenge}` },
          },
        ],
      },
      leaguesById: {
        [input.pilotSleeperLeagueId]: {
          league_id: input.pilotSleeperLeagueId,
          name: "The Pilot",
          season: "2026",
          sport: "nfl",
        },
      },
    });
    const verified = await verifyCommissionerChallenge(
      makeDeps({
        sleeperClient: matchingClient,
        pilotSleeperLeagueId: input.pilotSleeperLeagueId,
        now: () => input.requestNow + 10,
      }),
      { clerkUserId: commishUser.id },
    );
    if (!verified.ok) throw new Error("expected verification to succeed");
    await activateLeague(env.DB, verified.league.id, input.requestNow + 20);
    return { commishUser, sleeperClient, verified };
  }
});

// Sanity check for the concurrent-link-race test above, and documentation of the exact
// constraint it relies on: `linkSleeperAccount` throws (rather than silently upserting) on a
// duplicate `sleeper_user_id`.
describe("linkSleeperAccount constraint (sanity check for the race test above)", () => {
  it("throws on a duplicate sleeper_user_id instead of silently upserting", async () => {
    const now = Date.now();
    const first = await seedUser("user_constraint_check_1", "constraint-check-1@example.test");
    const second = await seedUser("user_constraint_check_2", "constraint-check-2@example.test");
    await linkSleeperAccount(env.DB, {
      userId: first.id,
      sleeperUserId: "sleeper_constraint_check",
      username: "a",
      displayName: "A",
      now,
    });
    await expect(
      linkSleeperAccount(env.DB, {
        userId: second.id,
        sleeperUserId: "sleeper_constraint_check",
        username: "b",
        displayName: "B",
        now,
      }),
    ).rejects.toThrow();
  });
});
