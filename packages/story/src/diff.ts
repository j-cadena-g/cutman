import type { PlayerMap, SleeperMatchup } from "@cutman/sleeper";
import { playerLabel, teamLabel } from "./labels.ts";
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

/** Margin that makes a final a one-score game. */
export const ONE_SCORE_MARGIN = 8;

export type DiffOptions = {
  /** The next snapshot's week is final. Live weeks never produce close-game or bench-shame facts. */
  settled: boolean;
  /** The previous snapshot was the same week, already final. Only then does it dedupe bench shame. */
  prevSettled?: boolean;
};

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
      facts.push({
        kind: "trade",
        transactionId: tx.transaction_id,
        copy: tradeCopy(names, tx, next, players),
      });
      continue;
    }
    if (tx.type === "free_agent" || tx.type === "waiver") {
      const adds = Object.keys(tx.adds ?? {}).map((id) => playerLabel(id, players));
      const drops = Object.keys(tx.drops ?? {}).map((id) => playerLabel(id, players));
      const how = tx.type === "waiver" ? "off waivers" : "in free agency";
      const manager = names[0] ?? "A manager";
      const copy = adds.length
        ? `${manager} picked up ${adds.join(", ")} ${how}${drops.length ? ` and dropped ${drops.join(", ")}` : ""}.`
        : `${manager} dropped ${drops.join(", ") || "a player"}.`;
      facts.push({ kind: "waiver", transactionId: tx.transaction_id, copy });
    }
  }
  return facts;
}

function clauseList(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(" ");
}

function receivedByRoster(
  adds: Record<string, number> | null | undefined,
  next: LeagueSnapshot,
  players: PlayerMap,
): string[] {
  const received = new Map<number, string[]>();
  for (const [playerId, rosterId] of Object.entries(adds ?? {})) {
    const roster = Number(rosterId);
    const list = received.get(roster) ?? [];
    list.push(playerLabel(playerId, players));
    received.set(roster, list);
  }
  return [...received.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([rosterId, list]) => `${teamLabel(next.users, next.rosters, rosterId)} received ${list.join(", ")}.`);
}

function tradeCopy(
  names: string[],
  tx: LeagueSnapshot["transactions"][number],
  next: LeagueSnapshot,
  players: PlayerMap,
): string {
  const picks = (tx.draft_picks ?? []).map((pick) => {
    const from = teamLabel(next.users, next.rosters, Number(pick.previous_owner_id));
    const to = teamLabel(next.users, next.rosters, Number(pick.owner_id));
    return `Picks: ${pick.season} round ${pick.round} from ${from} to ${to}.`;
  });
  const faab = (tx.waiver_budget ?? []).map((row) => {
    const sender = teamLabel(next.users, next.rosters, row.sender);
    const receiver = teamLabel(next.users, next.rosters, row.receiver);
    return `FAAB: ${sender} sent ${row.amount} to ${receiver}.`;
  });
  return clauseList([
    `${names.join(" and ")} completed a trade.`,
    ...receivedByRoster(tx.adds, next, players),
    ...picks,
    ...faab,
  ]);
}

/** Starters only. Live weeks also drop starters who have not scored yet. */
function labeledPlayerPoints(matchup: SleeperMatchup, players: PlayerMap, settled: boolean): string {
  const table = matchup.players_points;
  if (!table) return "";
  return (matchup.starters ?? [])
    .filter((id) => typeof table[id] === "number" && (settled || table[id] !== 0))
    .map((id) => `${playerLabel(id, players)} ${table[id]}`)
    .join(", ");
}

function points(value: number | null): string {
  return typeof value === "number" ? String(Number(value.toFixed(2))) : "—";
}

function matchupFacts(
  prev: LeagueSnapshot | null,
  next: LeagueSnapshot,
  players: PlayerMap,
  settled: boolean,
): StoryFact[] {
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
    const playerLine = [labeledPlayerPoints(left, players, settled), labeledPlayerPoints(right, players, settled)]
      .filter((line) => line.length > 0)
      .join(" vs ");
    const status = settled ? "Final" : "In progress, not final";
    facts.push({
      kind: "scoreboard",
      matchupId,
      copy: `${status}: ${leftName} ${points(left.points)} vs ${rightName} ${points(right.points)}.${playerLine ? ` ${playerLine}.` : ""}`,
    });
    if (
      settled &&
      typeof left.points === "number" &&
      typeof right.points === "number" &&
      Math.abs(left.points - right.points) <= ONE_SCORE_MARGIN
    ) {
      const margin = Math.abs(left.points - right.points);
      facts.push({
        kind: "rivalry",
        matchupId,
        copy:
          margin === 0
            ? `${leftName} and ${rightName} tied at ${points(left.points)}.`
            : `${left.points > right.points ? leftName : rightName} beat ${left.points > right.points ? rightName : leftName} by ${points(margin)}, a one-score game.`,
      });
    }
  }
  return facts;
}

function shamePair(matchup: SleeperMatchup): { key: string; worst: { id: string; pts: number }; best: { id: string; pts: number } } | null {
  if (!hasPlayerPoints(matchup)) return null;
  const starters = new Set(matchup.starters ?? []);
  const bench = (matchup.players ?? []).filter((id) => !starters.has(id));
  if (bench.length === 0) return null;
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
  if (!worstStarter || !bestBench) return null;
  if (bestBench.pts <= worstStarter.pts) return null;
  return {
    key: `${matchup.roster_id}:${worstStarter.id}:${bestBench.id}`,
    worst: worstStarter,
    best: bestBench,
  };
}

function benchShameFacts(
  prev: LeagueSnapshot | null,
  next: LeagueSnapshot,
  players: PlayerMap,
  options: DiffOptions,
): StoryFact[] {
  // Mid-week, most starters have not played, so the bench comparison means nothing yet.
  if (!options.settled) return [];
  const previousPairs = new Set<string>();
  if (prev && options.prevSettled && prev.week === next.week) {
    for (const matchup of prev.matchups) {
      const pair = shamePair(matchup);
      if (pair) previousPairs.add(pair.key);
    }
  }
  const facts: StoryFact[] = [];
  for (const matchup of next.matchups) {
    const pair = shamePair(matchup);
    if (!pair || previousPairs.has(pair.key)) continue;
    const name = teamLabel(next.users, next.rosters, matchup.roster_id);
    facts.push({
      kind: "bench_shame",
      rosterId: matchup.roster_id,
      copy: `${name} left ${playerLabel(pair.best.id, players)} (${pair.best.pts}) on the pine while ${playerLabel(pair.worst.id, players)} put up ${pair.worst.pts}.`,
    });
  }
  return facts;
}

export function diffSnapshots(
  prev: LeagueSnapshot | null,
  next: LeagueSnapshot,
  players: PlayerMap,
  options: DiffOptions,
): StoryFact[] {
  const facts = [
    ...transactionFacts(prev, next, players),
    ...matchupFacts(prev, next, players, options.settled),
    ...benchShameFacts(prev, next, players, options),
  ];
  return facts;
}

export async function factsIfChanged(
  prevHash: string | null,
  nextHash: string,
  prev: LeagueSnapshot | null,
  next: LeagueSnapshot,
  players: PlayerMap,
  options: DiffOptions,
): Promise<StoryFact[]> {
  if (prevHash === nextHash) return [];
  return diffSnapshots(prev, next, players, options);
}
