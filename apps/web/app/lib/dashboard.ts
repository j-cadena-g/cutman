import { UNBOOTSTRAPPED_MESSAGE, type Dashboard } from "../../workers/league-brain.ts";

// `Dashboard` is type-only (erased at build time, per this repo's `verbatimModuleSyntax`).
// `UNBOOTSTRAPPED_MESSAGE` is the exact `readSettings` string so empty-book matching cannot
// drift from LeagueBrain.
export type DashboardStub = { getDashboard(): Promise<Dashboard> };

// Exact message `LeagueBrain.readSettings` throws when settings rows are missing. Matched by
// identity (`instanceof Error` + exact `message`), not a substring, so unrelated DO / RPC
// failures cannot be mistaken for the expected empty-book window.
export function isUnbootstrappedDashboardError(error: unknown): error is Error {
  return error instanceof Error && error.message === UNBOOTSTRAPPED_MESSAGE;
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
