import type { Dashboard } from "../../workers/league-brain.ts";

// A `type`-only import (erased at build time, per this repo's `verbatimModuleSyntax`) — this file
// never actually imports `workers/league-brain.ts`'s runtime code, so it stays safe to reference
// from route loaders without pulling Durable Object code into the client bundle.
export type DashboardStub = { getDashboard(): Promise<Dashboard> };

// Exact message `LeagueBrain.readSettings` throws when settings rows are missing. Matched by
// identity (`instanceof Error` + exact `message`), not a substring, so unrelated DO / RPC
// failures cannot be mistaken for the expected empty-book window.
const LEAGUE_BRAIN_UNBOOTSTRAPPED_MESSAGE = "Cutman is not bootstrapped";

export function isUnbootstrappedDashboardError(error: unknown): error is Error {
  return error instanceof Error && error.message === LEAGUE_BRAIN_UNBOOTSTRAPPED_MESSAGE;
}

// A league can flip to `status === "active"` in D1 slightly before its LeagueBrain Durable
// Object has actually been bootstrapped — Task 4 owns provisioning/activation, and once it lands
// this should be a short, transient window rather than a steady state. `getDashboard()` throws
// `Error("Cutman is not bootstrapped")` in that gap; treat only that documented empty state as
// `null` so callers can render setting-up/empty-book. Any other thrown value is an outage and
// must reach the route error path. The expected window is not logged: it is not a failure, and
// unexpected errors surface through the route/Worker error path instead of a swallowed
// `console.error`.
export async function getDashboardOrNull(stub: DashboardStub): Promise<Dashboard | null> {
  try {
    return await stub.getDashboard();
  } catch (error) {
    if (isUnbootstrappedDashboardError(error)) return null;
    throw error;
  }
}
