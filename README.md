# Cutman

Cutman is the season story for your Sleeper league.

This repo is public for visibility and is not a place to send PRs.

Licensing is TBD.

## What you get

- Clerk sign-in only. Recaps still go out through Cloudflare Email Service as `Cutman <hello@mail.cutman.io>`
- v1 runs one configured Sleeper league. D1 already models many leagues; one LeagueBrain Durable Object per league id
- Dashboard reads the Durable Object snapshot (bible, timeline, recaps). It does not hit Sleeper on every page load
- D1 holds Clerk users, leagues, and per-league membership / recap opt-in. KV holds the NFL player map
- Cron is hourly UTC; the handler uses `America/New_York`. Poll every 3 hours. One idempotent Tuesday recap at 9:00
- Default tone is playful when unset

## Quick Start

You do **not** need a Cloudflare account, Workers Builds, Cursor Cloud Agent secrets, or a production Environment to open the repo. Local Vite uses simulated D1/KV.

### Prerequisites

- Node 22.22+ and pnpm 10
- A **personal** [Clerk](https://clerk.com/) development application (`pk_test_` / `sk_test_`)
- [1Password CLI](https://developer.1password.com/docs/cli/) and **your own** 1Password Environment for secrets (recommended). You can instead export the required env vars in your shell; if `OP_ENVIRONMENT_ID` is unset, `pnpm run dev` runs with the current environment.

### Get Clerk keys

1. Create your own Clerk application (Development instance).
2. Copy the publishable key (`pk_test_…`) and secret key (`sk_test_…`).
3. In Clerk, allow the local origin `http://127.0.0.1:41789` (and matching sign-in/redirect URLs).

### Install and Run

1. Create a personal 1Password Environment for local development (a common display name is `Cutman (dev)`), **or** plan to export required vars in your shell.
2. Set the **required** keys from [`apps/web/.dev.vars.example`](./apps/web/.dev.vars.example): `APP_ENV`, `APP_ORIGIN`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`. Cloudflare account / zone / D1 / KV IDs belong only on the deploy manifest.

```bash
pnpm install

cp apps/web/.op/refs.env.example apps/web/.op/refs.env
# Set OP_ENVIRONMENT_ID to the UUID of your personal local-dev Environment
# (skip refs.env if you export the required vars in your shell instead).

pnpm run dev:verify
pnpm run dev
```

Or, if you are signed into the 1Password CLI:

```bash
op run --environment "Cutman (dev)" -- pnpm dev
```

App: http://127.0.0.1:41789

```bash
pnpm test
pnpm typecheck
```

Set `USE_SLEEPER_FIXTURES=true` in your Environment to use canned example-league data (CI always does). Leave it `false` to hit the live Sleeper API for membership checks and cron polls.

Local `pnpm run dev` does not call Workers AI (no Cloudflare login). Gemma writes beats and recaps after deploy.

### Local Environment Notes

- Copy [`apps/web/.op/refs.env.example`](./apps/web/.op/refs.env.example) to `apps/web/.op/refs.env` and set `OP_ENVIRONMENT_ID` to the UUID of **your** local-dev Environment. Prefer `op run`; if `OP_ENVIRONMENT_ID` is unset, [`scripts/run-with-1password-environment.sh`](./scripts/run-with-1password-environment.sh) falls through to your current shell environment.
- `Cutman (dev)` / `cutman (prod)` in this repo are **suggested display names** for personal or operator Environments — not shared Environments contributors are expected to join.
- `pnpm run dev` uses `op run --environment` (when configured) to inject secrets into `process.env`; the Cloudflare Vite plugin reads them directly (`CLOUDFLARE_INCLUDE_PROCESS_ENV`). Do not create, mount, or commit a `.dev.vars` file.
- `pnpm run dev:verify` checks **required** keys from `apps/web/.dev.vars.example` (names only).
- Secrets and deploy identifiers should live in each person’s (or each operator’s) 1Password Environments; the repo only tracks variable **names** in `*.example` manifests.
- `pnpm run deploy` also uses `op run` and renders ignored `apps/web/.wrangler.deploy.jsonc` from environment variables, so live Cloudflare IDs and domains do not need to live in git.

## Environment and Config

| File / Source | Purpose |
| --- | --- |
| `apps/web/.dev.vars.example` | Key manifest for local dev (`op run` + `dev:verify`). Required: `APP_ENV`, `APP_ORIGIN`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`. Optional: `V1_LEAGUE_ID`, `V1_LEAGUE_NAME`, `V1_SLEEPER_USER_ID`, `V1_SLEEPER_USERNAME` (fake placeholders in git; live values in 1Password) |
| `apps/web/.deploy.env.example` | Deploy binding IDs and Worker vars (rendered into `apps/web/.wrangler.deploy.jsonc`) |
| `apps/web/.wrangler.secrets.example` | Worker secrets for deploy (`wrangler deploy --secrets-file`). Today: `CLERK_SECRET_KEY` |
| `apps/web/.op/refs.env.example` | Template for local `OP_ENVIRONMENT_ID` (copy to gitignored `apps/web/.op/refs.env`) |
| `apps/web/.op/refs.env` or `OP_ENVIRONMENT_ID` | 1Password Environment reference for `op run` (dev locally / cloud agents, prod in Workers Builds) |
| `apps/web/wrangler.jsonc` | Public-safe Wrangler template. `V1_LEAGUE_ID` and `EMAIL_FROM` stay as vars; tracked `V1_*` values are fake placeholders |
| `apps/web/.wrangler.deploy.jsonc` | Ignored production config rendered at deploy time |

Current Worker bindings in the public `apps/web/wrangler.jsonc` template:

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 | Clerk users, leagues, memberships, recap opt-in |
| `PLAYERS` | KV | NFL player map, fetched at most once per day |
| `LEAGUE_BRAIN` | SQLite Durable Object | Snapshots, beats, bible, recaps. id = configured `V1_LEAGUE_ID` |
| `AI` | Workers AI | `@cf/google/gemma-4-26b-a4b-it` only |
| `EMAIL` | Email Service | `env.EMAIL.send` for Tuesday recaps. From-name is **Cutman** |
| Cron | `0 * * * *` UTC | Handler uses Eastern Time: poll every 3h; recap Tuesday 9:00 |

The worker applies D1 migration `0001_init.sql` (multi-league schema). v1 still `INSERT OR IGNORE`s the single configured league from Environment `V1_*` vars. Production renders require those vars so placeholder identities from `wrangler.jsonc` cannot ship. For a CLI-managed local D1:

```bash
pnpm run db:migrate:local
```

If your local D1 predates the current schema (or you just want a clean slate), reset it — this
is **local-only**: it deletes `apps/web/.wrangler/state/v3/d1` and nothing else, then reapplies
`0001_init.sql`. It never touches remote D1.

```bash
pnpm run db:reset:local
```

Generate Env types:

```bash
pnpm cf-typegen
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm run dev` | Start the local Vite + Workers development server |
| `pnpm run dev:verify` | Verify required local-dev secrets via `op run` (names only) |
| `pnpm run deploy` | Apply remote D1 migrations, then deploy the Worker with `--secrets-file` |
| `pnpm run db:migrate:local` | Apply migrations to the local D1 database |
| `pnpm run db:migrate:remote` | Apply migrations to the remote D1 database |
| `pnpm run db:reset:local` | Wipe local D1 state and reapply migrations (local only; never touches remote) |
| `pnpm run typecheck` | Generate Wrangler + route types and run TypeScript |
| `pnpm run test` | Run Vitest suites |

## Deployment

`pnpm run deploy` first renders `apps/web/.wrangler.deploy.jsonc` from the current shell environment, then uses that ignored file for remote D1 migrations and the Worker deploy. The committed [`apps/web/wrangler.jsonc`](./apps/web/wrangler.jsonc) stays as a public-safe template.

Operators should store production and development secrets in [1Password Environments](https://www.1password.dev/environments/). The repo tracks **names** in [`apps/web/.deploy.env.example`](./apps/web/.deploy.env.example) and [`apps/web/.wrangler.secrets.example`](./apps/web/.wrangler.secrets.example). Do not use `wrangler secret put` or the Cloudflare dashboard to author secrets — `pnpm run deploy` renders a temporary secrets file from `op run` and passes it to `wrangler deploy --secrets-file`.

Suggested Environment display names (create these in **your** 1Password account; they are not shared project vaults):

- **`Cutman (dev)`** — local `pnpm run dev` (`OP_ENVIRONMENT_ID` in `apps/web/.op/refs.env`).
- **`cutman (prod)`** — Cloudflare Workers Builds / production deploy (`OP_ENVIRONMENT_ID` build secret). Only needed if you operate a deployment.

Each Environment should define every key from the relevant manifests (dev vs prod values differ, e.g. `pk_test_` vs `pk_live_`). Local-dev Environments only need the **required** keys in `.dev.vars.example` for a first run. Live Sleeper league/user ids (`V1_LEAGUE_ID`, `V1_LEAGUE_NAME`, `V1_SLEEPER_USER_ID`, `V1_SLEEPER_USERNAME`) belong in **`Cutman (dev)`** (and the deploy Environment), not in git.

Local deploy (operators): copy [`apps/web/.op/refs.env.example`](./apps/web/.op/refs.env.example) to `apps/web/.op/refs.env`, set `OP_ENVIRONMENT_ID` to **your** production Environment UUID, then `pnpm run deploy`. The deploy renderer defaults `APP_ENV` to `production`.

Onboard **cutman.io** in Cloudflare **Compute → Email Service → Email Sending** (SPF/DKIM/DMARC on the zone). Keep the `send_email` binding named `EMAIL` and `EMAIL_FROM` as `Cutman <hello@mail.cutman.io>`. The visible from-name is **Cutman**, never Hello, never Cutman App, never the raw mailbox.

### Cloudflare Workers Builds

Git-connected production deploys must not use the placeholder [`apps/web/wrangler.jsonc`](./apps/web/wrangler.jsonc) alone. The build must render `apps/web/.wrangler.deploy.jsonc` with real binding IDs.

This section is for **operators** of a deployment:

1. Use **your** production 1Password Environment (commonly named `cutman (prod)`) for production binding IDs and deploy keys. Keep a separate local-dev Environment (commonly `Cutman (dev)`) for day-to-day development.
2. Add every key from [`apps/web/.deploy.env.example`](./apps/web/.deploy.env.example) and [`apps/web/.wrangler.secrets.example`](./apps/web/.wrangler.secrets.example) to that production Environment.
3. Add Workers Builds secrets: **only** `OP_SERVICE_ACCOUNT_TOKEN` (read-only service account) and `OP_ENVIRONMENT_ID` set to **your** production Environment UUID.
4. Workers Builds commands (Worker **Settings → Build**):
   - **Build:** `pnpm install && pnpm run build`
   - **Deploy:** `pnpm run deploy`

If Workers Builds was still running plain `wrangler deploy` against the template config, the post-merge failure is expected: add the bootstrap secrets and set the deploy command above.

If you want to deploy this project to a different Cloudflare account or domain, change the deploy-time environment variables instead of editing the committed `apps/web/wrangler.jsonc`.

## Cursor Cloud Agents

Cursor cloud agents should **not** copy individual app secrets into the Cursor dashboard. Use the same bootstrap pattern as Cloudflare Workers Builds, pointed at **your** local-dev Environment:

1. Create a read-only 1Password service account scoped to **your** local-dev Environment only (separate from any production Workers Builds token).
2. In Cursor → Cloud Agents → your Cutman environment → Secrets, add only:

| Secret | Cursor type | Value |
| --- | --- | --- |
| `OP_SERVICE_ACCOUNT_TOKEN` | Runtime Secret | Read-only service account with access to **your** local-dev Environment only |
| `OP_ENVIRONMENT_ID` | Environment Variable | UUID of **your** local-dev Environment |

Do not add Clerk keys, Cloudflare binding IDs, or other keys from `apps/web/.dev.vars.example` to Cursor. Commands like `pnpm run dev` and `pnpm run dev:verify` inject them via `op run --environment` through [`scripts/run-with-1password-environment.sh`](./scripts/run-with-1password-environment.sh). Cloud agents resolve `OP_ENVIRONMENT_ID` from Cursor secrets (not from gitignored `apps/web/.op/refs.env`).

For the cloud environment **install/update** command, use `pnpm install` (local D1 schema is applied on first request; no app secrets required). After bootstrap secrets are set, run `pnpm run dev:verify` to confirm your Environment is complete (names only).
