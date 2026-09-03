/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { ensureSchema, getLeague, upsertUserByClerkId } from "@cutman/db";
import type { NflState, SleeperClient, SleeperLeague, SleeperLeagueUser, SleeperUser } from "@cutman/sleeper";
import {
  EXAMPLE_COMMISSIONER_CHALLENGE,
  EXAMPLE_COMMISSIONER_USERNAME,
  V1_LEAGUE_ID,
  createFixtureClient,
  v1FixtureUsers,
} from "@cutman/sleeper";
import { beforeAll, describe, expect, it } from "vitest";
import { getDashboardOrNull } from "../app/lib/dashboard.ts";
import {
  connectSleeperAccount,
  requestCommissionerChallenge,
  verifyCommissionerChallenge,
  type OnboardingDeps,
} from "../app/lib/onboarding.server.ts";
import { provisionAndActivateLeague, provisioningDepsFromEnv } from "../app/lib/provisioning.server.ts";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

let idCounter = 0;

function makeDeps(overrides: Partial<OnboardingDeps> & { sleeperClient: SleeperClient; pilotSleeperLeagueId: string }): OnboardingDeps {
  return {
    db: env.DB,
    now: () => 1_806_000_000_000,
    generateChallenge: () => EXAMPLE_COMMISSIONER_CHALLENGE,
    generateId: () => `verification_provision_${idCounter++}`,
    challengeTtlMs: 15 * 60 * 1000,
    ...overrides,
  };
}

function createFakeSleeperClient(config: {
  usersByLookup?: Record<string, SleeperUser>;
  nflState?: NflState;
  leagueUsersById?: Record<string, SleeperLeagueUser[]>;
  leaguesById?: Record<string, SleeperLeague>;
}): SleeperClient {
  return {
    async getNflState() {
      return config.nflState ?? { week: 1, season_type: "regular", season: "2026", league_season: "2026" };
    },
    async getUser(usernameOrId) {
      return config.usersByLookup?.[usernameOrId] ?? null;
    },
    async getUserLeagues() {
      return [];
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

async function seedUser(id: string, email: string) {
  await ensureSchema(env.DB);
  return upsertUserByClerkId(env.DB, { id, email, now: Date.now() });
}

async function settingKeys(name: string): Promise<string[]> {
  const stub = env.LEAGUE_BRAIN.getByName(name);
  const rows = await runInDurableObject(stub, async (_instance, state) => {
    return state.storage.sql.exec("SELECT key FROM settings").toArray() as Array<{ key: string }>;
  });
  return rows.map((row) => row.key);
}

describe("verify then provision", () => {
  it("does not bootstrap a Durable Object; verify leaves the league in provisioning", async () => {
    const user = await seedUser("user_verify_no_do", "verify-no-do@example.test");
    const pilotSleeperLeagueId = "sleeper_verify_no_do";
    const sleeperClient = createFakeSleeperClient({
      usersByLookup: {
        commish: { user_id: "sleeper_verify_no_do", username: "commish", display_name: "Commish" },
      },
      leagueUsersById: {
        [pilotSleeperLeagueId]: [
          {
            user_id: "sleeper_verify_no_do",
            username: "commish",
            display_name: "Commish",
            is_owner: true,
            metadata: { team_name: `Team ${EXAMPLE_COMMISSIONER_CHALLENGE}` },
          },
        ],
      },
      leaguesById: {
        [pilotSleeperLeagueId]: {
          league_id: pilotSleeperLeagueId,
          name: "No DO Yet",
          season: "2026",
          sport: "nfl",
        },
      },
    });
    const deps = makeDeps({ sleeperClient, pilotSleeperLeagueId });
    await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: "commish" });
    const requested = await requestCommissionerChallenge(deps, { clerkUserId: user.id });
    if (!requested.ok) throw new Error("expected challenge request to succeed");

    const result = await verifyCommissionerChallenge(deps, { clerkUserId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("provisioning");
    expect(result.league.activated_at).toBeNull();
    expect(await getLeague(env.DB, result.league.id)).toMatchObject({ status: "provisioning" });
    expect(await getDashboardOrNull(env.LEAGUE_BRAIN.getByName(result.league.id))).toBeNull();
    expect(await settingKeys(result.league.id)).toEqual([]);
  });

  it("verify then provision yields active and a current-state snapshot", async () => {
    const user = await seedUser("user_verify_then_provision", "verify-then-provision@example.test");
    const deps = makeDeps({ sleeperClient: createFixtureClient(), pilotSleeperLeagueId: V1_LEAGUE_ID });
    await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput: EXAMPLE_COMMISSIONER_USERNAME });
    const requested = await requestCommissionerChallenge(deps, { clerkUserId: user.id });
    if (!requested.ok) throw new Error("expected challenge request to succeed");
    expect(requested.challenge).toBe(EXAMPLE_COMMISSIONER_CHALLENGE);

    const verified = await verifyCommissionerChallenge(deps, { clerkUserId: user.id });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("expected ok");
    expect(verified.league.status).toBe("provisioning");
    expect(verified.membership.role).toBe("commissioner");
    expect(await getDashboardOrNull(env.LEAGUE_BRAIN.getByName(verified.league.id))).toBeNull();

    const provisioned = await provisionAndActivateLeague(
      provisioningDepsFromEnv(env, verified.league.id, () => 1_806_000_000_050),
      verified.league,
    );

    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) throw new Error("expected ok");
    expect(provisioned.league.status).toBe("active");
    expect(provisioned.league.activated_at).toBe(1_806_000_000_050);
    expect(provisioned.league.provisioning_error).toBeNull();

    const dashboard = await env.LEAGUE_BRAIN.getByName(verified.league.id).getDashboard();
    expect(dashboard.leagueId).toBe(verified.league.id);
    expect(dashboard.sleeperLeagueId).toBe(V1_LEAGUE_ID);
    expect(dashboard.week).toBe(1);
    expect(dashboard.lastHash).not.toBeNull();

    const snapshotUsers = await runInDurableObject(env.LEAGUE_BRAIN.getByName(verified.league.id), async (_instance, state) => {
      const row = state.storage.sql.exec("SELECT payload FROM snapshots ORDER BY id DESC LIMIT 1").toArray()[0] as
        | { payload: string }
        | undefined;
      if (!row) throw new Error("expected a stored snapshot");
      return (JSON.parse(row.payload) as { users: unknown[] }).users;
    });
    expect(snapshotUsers).toHaveLength(v1FixtureUsers.length);
  });
});
