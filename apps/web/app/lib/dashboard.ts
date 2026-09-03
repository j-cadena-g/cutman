import type { Dashboard } from "../../workers/league-brain.ts";

// A `type`-only import (erased at build time, per this repo's `verbatimModuleSyntax`) — this file
// never actually imports `workers/league-brain.ts`'s runtime code, so it stays safe to reference
// from route loaders without pulling Durable Object code into the client bundle.
export type DashboardStub = { getDashboard(): Promise<Dashboard> };

// A league can flip to `status === "active"` in D1 slightly before its LeagueBrain Durable
// Object has actually been bootstrapped — Task 4 owns provisioning/activation, and once it lands
// this should be a short, transient window rather than a steady state. `getDashboard()` throws
// ("Cutman is not bootstrapped") in that gap; never let that reach a route as an uncaught
// exception. Callers render a setting-up/empty-book state for `null` instead.
export async function getDashboardOrNull(stub: DashboardStub): Promise<Dashboard | null> {
  try {
    return await stub.getDashboard();
  } catch {
    return null;
  }
}
