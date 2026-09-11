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
- v1 runtime uses one configured pilot Sleeper league (`PILOT_SLEEPER_LEAGUE_ID` from gitignored / 1Password `Cutman (dev)`, never a live id in tracked files). Other discovered leagues show Coming soon. D1 is multi-league: `leagues.id` plus unique `sleeper_league_id`, memberships keyed by `(league_id, user_id)`. LeagueBrain Durable Objects are keyed by internal `leagues.id`, not the Sleeper snowflake.
- Access is a Clerk session. Sign-in is the only gate. Commissioner authority comes only from successfully completing Sleeper ownership verification (`league_verifications`) for that league — a team-name challenge, then LeagueBrain provision — never from sign-in order. Once the league is active, members join without a challenge. New members default to `role = "member"` until they verify. No allowlist, claim flow, FF-XXXX, or magic-link.
- `ensureSchema` is purely additive (`CREATE TABLE/INDEX IF NOT EXISTS`, never `DROP`). Deployment applies `0002_sleeper_onboarding.sql` to migrate a remote D1 that already has the original legacy `0001`, then `0003_recap_attempt_backlog.sql`, then `0004_explorer_origin_quota.sql`; no remote wipe is needed for that schema. If local D1 predates a schema change (including a local DB that applied a rewritten `0001` before `0002` existed), run `pnpm run db:reset:local` (wipes only `apps/web/.wrangler/state/v3/d1`, then reapplies `0001_init.sql`, `0002_sleeper_onboarding.sql`, `0003_recap_attempt_backlog.sql`, and `0004_explorer_origin_quota.sql`) — never `--remote`. `db:reset:local` never touches remote.
- Dashboard reads the LeagueBrain snapshot. Do not hit Sleeper on every page load.
- Mail from `Cutman <hello@mail.cutman.io>` only. Visible from-name is **Cutman**.
- Workers AI model is `@cf/google/gemma-4-26b-a4b-it` only. Local `pnpm run dev` must not force Cloudflare OAuth (`remoteBindings: false`).
- Default tone is playful when unset. Tuesday recap is 9:00 America/New_York, once, idempotent.
