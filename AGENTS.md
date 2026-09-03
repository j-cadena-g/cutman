# Agent notes for Cutman

Short working loop. Human setup lives in [README Quick Start](./README.md#quick-start).

## Commands

| Task | Command |
| --- | --- |
| Dev server | `pnpm run dev` |
| Check secrets (names only) | `pnpm run dev:verify` |
| Lint | `pnpm run lint` |
| Types | `pnpm run typecheck` |
| Tests | `pnpm run test` |
| Schema migration (local) | `pnpm run db:migrate:local` |
| Reset local D1 (destructive, local only) | `pnpm run db:reset:local` |

Prefer `pnpm run test` over driving the browser to verify behavior.

## Invariants

- Do not create, mount, or commit `.dev.vars`. Local Vite reads secrets from `process.env` via `op run` and `CLOUDFLARE_INCLUDE_PROCESS_ENV`.
- Do not commit live Cloudflare account, zone, D1, or KV IDs. Those belong only in a deploy Environment and the ignored `.wrangler.deploy.jsonc`.
- v1 runtime uses one configured Sleeper league (`V1_LEAGUE_ID` from gitignored / 1Password `Cutman (dev)`, never a live id in tracked files). D1 is multi-league: `leagues.id` plus unique `sleeper_league_id`, memberships keyed by `(league_id, user_id)`.
- Access is a Clerk session. Sign-in is the only gate. The first Clerk user in the league is commissioner. No allowlist, claim flow, FF-XXXX, or magic-link.
- `ensureSchema` is purely additive (`CREATE TABLE/INDEX IF NOT EXISTS`, never `DROP`). If local D1 predates a schema change, run `pnpm run db:reset:local` (wipes only `apps/web/.wrangler/state/v3/d1`, then reapplies `0001_init.sql`) — never `--remote`.
- Dashboard reads the LeagueBrain snapshot. Do not hit Sleeper on every page load.
- Mail from `Cutman <hello@mail.cutman.io>` only. Visible from-name is **Cutman**.
- Workers AI model is `@cf/google/gemma-4-26b-a4b-it` only. Local `pnpm run dev` must not force Cloudflare OAuth (`remoteBindings: false`).
- Default tone is playful when unset. Tuesday recap is 9:00 America/New_York, once, idempotent.
