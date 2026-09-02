import type { PlayerMap, SleeperLeagueUser, SleeperMatchup, SleeperRoster } from "@cutman/sleeper";
import type { LeagueSnapshot } from "./snapshot.ts";
import { hasPlayerPoints } from "./week.ts";

export type StoryFact =
  | {
      kind: "trade";
      copy: string;
      transactionId: string;
    }
  | {
      kind: "waiver";
      copy: string;
      transactionId: string;
    }
  | {
      kind: "scoreboard";
      copy: string;
      matchupId: number | null;
    }
  | {
      kind: "bench_shame";
      copy: string;
      rosterId: number;
    }
  | {
      kind: "rivalry";
      copy: string;
      matchupId: number | null;
    };

function teamLabel(users: SleeperLeagueUser[], rosters: SleeperRoster[], rosterId: number): string {
  const roster = rosters.find((entry) => entry.roster_id === rosterId);
  const user = users.find((entry) => entry.user_id === roster?.owner_id);
  return user?.metadata?.team_name || user?.display_name || `Roster ${rosterId}`;
}

function playerLabel(playerId: string, players: PlayerMap): string {
  return players[playerId]?.full_name ?? `Player ${playerId}`;
}

function transactionFacts(
  prev: LeagueSnapshot | null,
  next: LeagueSnapshot,
  players: PlayerMap,
): StoryFact[] {
  const seen = new Set((prev?.transactions ?? []).map((tx) => tx.transaction_id));
  const facts: StoryFact[] = [];
  for (const tx of next.transactions) {
    if (tx.status !== "complete" || seen.has(tx.transaction_id)) continue;
    const names = tx.roster_ids.map((id) => teamLabel(next.users, next.rosters, id));
    if (tx.type === "trade") {
      const moved = Object.keys(tx.adds ?? {}).map((id) => playerLabel(id, players));
      facts.push({
        kind: "trade",
        transactionId: tx.transaction_id,
        copy: `${names.join(" and ")} completed a trade${moved.length ? `: ${moved.join(", ")}` : ""}.`,
      });
      continue;
    }
    if (tx.type === "free_agent" || tx.type === "waiver") {
      const adds = Object.keys(tx.adds ?? {}).map((id) => playerLabel(id, players));
      const drops = Object.keys(tx.drops ?? {}).map((id) => playerLabel(id, players));
      facts.push({
        kind: "waiver",
        transactionId: tx.transaction_id,
        copy: `${names[0] ?? "A manager"} hit the wire${adds.length ? ` for ${adds.join(", ")}` : ""}${drops.length ? `, dumping ${drops.join(", ")}` : ""}.`,
      });
    }
  }
  return facts;
}

function matchupFacts(prev: LeagueSnapshot | null, next: LeagueSnapshot): StoryFact[] {
  const prevByRoster = new Map((prev?.matchups ?? []).map((matchup) => [matchup.roster_id, matchup]));
  const grouped = new Map<number | null, SleeperMatchup[]>();
  for (const matchup of next.matchups) {
    const list = grouped.get(matchup.matchup_id) ?? [];
    list.push(matchup);
    grouped.set(matchup.matchup_id, list);
  }

  const facts: StoryFact[] = [];
  for (const [matchupId, pair] of grouped) {
    if (pair.length < 2) continue;
    const [left, right] = pair;
    if (!left || !right) continue;
    const leftPrev = prevByRoster.get(left.roster_id);
    const rightPrev = prevByRoster.get(right.roster_id);
    const scoreChanged =
      leftPrev?.points !== left.points || rightPrev?.points !== right.points || !prev;
    if (!scoreChanged) continue;
    const leftName = teamLabel(next.users, next.rosters, left.roster_id);
    const rightName = teamLabel(next.users, next.rosters, right.roster_id);
    facts.push({
      kind: "scoreboard",
      matchupId,
      copy: `${leftName} ${left.points ?? "—"} vs ${rightName} ${right.points ?? "—"}.`,
    });
    if (
      typeof left.points === "number" &&
      typeof right.points === "number" &&
      Math.abs(left.points - right.points) <= 8
    ) {
      facts.push({
        kind: "rivalry",
        matchupId,
        copy: `${leftName} and ${rightName} are inside a one-score game. This one is going in the bible.`,
      });
    }
  }
  return facts;
}

function benchShameFacts(snapshot: LeagueSnapshot, players: PlayerMap): StoryFact[] {
  const facts: StoryFact[] = [];
  for (const matchup of snapshot.matchups) {
    if (!hasPlayerPoints(matchup)) continue;
    const starters = new Set(matchup.starters ?? []);
    const bench = (matchup.players ?? []).filter((id) => !starters.has(id));
    if (bench.length === 0) continue;
    let worstStarter: { id: string; pts: number } | null = null;
    for (const starterId of starters) {
      const pts = matchup.players_points?.[starterId];
      if (typeof pts !== "number") continue;
      if (!worstStarter || pts < worstStarter.pts) worstStarter = { id: starterId, pts };
    }
    let bestBench: { id: string; pts: number } | null = null;
    for (const benchId of bench) {
      const pts = matchup.players_points?.[benchId];
      if (typeof pts !== "number") continue;
      if (!bestBench || pts > bestBench.pts) bestBench = { id: benchId, pts };
    }
    if (!worstStarter || !bestBench) continue;
    if (bestBench.pts <= worstStarter.pts) continue;
    const name = teamLabel(snapshot.users, snapshot.rosters, matchup.roster_id);
    facts.push({
      kind: "bench_shame",
      rosterId: matchup.roster_id,
      copy: `${name} left ${playerLabel(bestBench.id, players)} (${bestBench.pts}) on the pine while ${playerLabel(worstStarter.id, players)} put up ${worstStarter.pts}.`,
    });
  }
  return facts;
}

export function diffSnapshots(
  prev: LeagueSnapshot | null,
  next: LeagueSnapshot,
  players: PlayerMap = {},
): StoryFact[] {
  const facts = [
    ...transactionFacts(prev, next, players),
    ...matchupFacts(prev, next),
    ...benchShameFacts(next, players),
  ];
  return facts;
}

export async function factsIfChanged(
  prevHash: string | null,
  nextHash: string,
  prev: LeagueSnapshot | null,
  next: LeagueSnapshot,
  players: PlayerMap = {},
): Promise<StoryFact[]> {
  if (prevHash === nextHash) return [];
  return diffSnapshots(prev, next, players);
}
