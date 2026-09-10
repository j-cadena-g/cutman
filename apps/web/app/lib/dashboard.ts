import {
  LEGACY_IMPORT_PENDING_MESSAGE,
  UNBOOTSTRAPPED_MESSAGE,
  type Dashboard,
} from "../../workers/league-brain.ts";

// `Dashboard` is type-only (erased at build time, per this repo's `verbatimModuleSyntax`).
// Message constants are the exact `readSettings` strings so empty-book matching cannot
// drift from LeagueBrain.
export type DashboardStub = { getDashboard(): Promise<Dashboard> };

// Exact message `LeagueBrain.readSettings` throws when settings rows are missing. Matched by
// identity (`instanceof Error` + exact `message`), not a substring, so unrelated DO / RPC
// failures cannot be mistaken for the expected empty-book window.
export function isUnbootstrappedDashboardError(error: unknown): error is Error {
  return error instanceof Error && error.message === UNBOOTSTRAPPED_MESSAGE;
}

// Exact message while a legacy history copy is still in flight. Same identity match as
// unbootstrapped: substring / non-Error values must not be treated as empty-book.
export function isLegacyImportPendingDashboardError(error: unknown): error is Error {
  return error instanceof Error && error.message === LEGACY_IMPORT_PENDING_MESSAGE;
}

// A league can flip to `status === "active"` in D1 slightly before its LeagueBrain Durable
// Object has actually been bootstrapped, and a migrated league can sit in
// `legacyImportPending` until the copy lands or is abandoned. `getDashboard()` throws
// `UNBOOTSTRAPPED_MESSAGE` or `LEGACY_IMPORT_PENDING_MESSAGE` in those gaps; treat only
// those documented empty states as `null` so callers can render setting-up/empty-book.
// Any other thrown value is an outage and must reach the route error path. The expected
// windows are not logged: they are not failures, and unexpected errors surface through
// the route/Worker error path instead of a swallowed `console.error`.
export async function getDashboardOrNull(stub: DashboardStub): Promise<Dashboard | null> {
  try {
    return await stub.getDashboard();
  } catch (error) {
    if (isUnbootstrappedDashboardError(error) || isLegacyImportPendingDashboardError(error)) return null;
    throw error;
  }
}
