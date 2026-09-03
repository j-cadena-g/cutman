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

Prefer `pnpm run test` over driving the browser to verify behavior.

## Invariants

- Do not create, mount, or commit `.dev.vars`. Local Vite reads secrets from `process.env` via `op run` and `CLOUDFLARE_INCLUDE_PROCESS_ENV`.
- Do not commit live Cloudflare account, zone, D1, or KV IDs. Those belong only in a deploy Environment and the ignored `.wrangler.deploy.jsonc`.
- v1 is one Sleeper league: **519 Keeper**, `V1_LEAGUE_ID=1389694122842918912` (a wrangler var, not a secret). Do not grow past one league.
- Access is a James-owned allowlist (Clerk email → Sleeper `user_id`) plus a live membership check on `/league/.../users`. No claim flow. No FF-XXXX. No magic-link.
- Do not invent James's Clerk email. Seed is Sleeper `jcadenag` / `994286029840424960` with `clerk_email` unset.
- Dashboard reads the LeagueBrain snapshot. Do not hit Sleeper on every page load.
- Mail from `Cutman <hello@mail.cutman.io>` only. Visible from-name is **Cutman**.
- Workers AI model is `@cf/google/gemma-4-26b-a4b-it` only. Local `pnpm run dev` must not force Cloudflare OAuth (`remoteBindings: false`).
- Default tone is playful when unset. Tuesday recap is 9:00 America/New_York, once, idempotent.
