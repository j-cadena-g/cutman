# Cutman

Cutman is the season story for your Sleeper league.

This repo is public for visibility and is not a place to send PRs.

Licensing is TBD.

## What you get

- Magic-link sign-in (httpOnly session cookie)
- Claim a Sleeper username, list this season's NFL leagues (`GET /state/nfl` → `league_season`)
- One-time verify: append `FF-XXXX` to your Sleeper team name; we confirm via league users and bind `sleeper_user_id`
- Enable a league (Durable Object id = Sleeper `league_id`). Member required. Commish = `is_owner`. First enabler may set tone until a commish appears
- Living dashboard: bible, timeline, recap archive, commish strip. Rosters stay on Sleeper
- Poll Sleeper, diff snapshots, Gemma writes beats. Same payload twice = no beat. No bench-shame without `players_points`
- Tuesday recap in `America/New_York` once every matchup has a finite numeric score. Archive, then email. One recap per league/week. Never a blank email. Model dresses facts only (`{copy}` / `{subject,body}`)

## Run locally

Requires Node 22.22+ and pnpm 10.

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm dev
```

App: http://127.0.0.1:41789

```bash
pnpm test
pnpm typecheck
```

Set `USE_SLEEPER_FIXTURES=true` in `.dev.vars` to use canned Sleeper data (CI always does). Leave it `false` to hit the live Sleeper API for your own username.

Local Email Sending is simulated: Wrangler logs the magic-link email. Open the `/auth/callback?token=…` URL from the log to finish sign-in.

Local `pnpm dev` does not call Workers AI (no Cloudflare login). Gemma writes beats and recaps after deploy.

## Cloudflare bindings

Configured in `apps/web/wrangler.jsonc`:

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 | Users, sessions, magic links, enabled leagues, recap opt-in |
| `PLAYERS` | KV | NFL player map, fetched at most once per day |
| `LEAGUE_BRAIN` | SQLite Durable Object | Per-league snapshots, beats, bible, recaps. id = Sleeper league id |
| `AI` | Workers AI | `@cf/google/gemma-4-26b-a4b-it` only |
| `EMAIL` | Email Service | `env.EMAIL.send` for magic links and Tuesday recaps |
| Cron | `0 * * * *` UTC | Handler uses Eastern Time: poll every 3h; recap Tue 9 / 13 / 19 |

The worker applies `apps/web/d1/0001_init.sql` on first request (`CREATE TABLE IF NOT EXISTS`). For a CLI-managed local D1:

```bash
pnpm --filter @cutman/web exec wrangler d1 migrations apply cutman --local --persist-to .wrangler/state
```

Generate Env types:

```bash
pnpm cf-typegen
```

Deploy:

```bash
pnpm --filter @cutman/web deploy
```

## Email Sending domain

Onboard **cutman.io** in Cloudflare **Compute → Email Service → Email Sending** (SPF/DKIM/DMARC on the zone). Then:

1. Keep the `send_email` binding named `EMAIL`
2. Set `EMAIL_FROM` to `Cutman <hello@mail.cutman.io>`
3. Set `APP_URL` to `https://cutman.io` so magic links point at production

Until the domain is onboarded, local `wrangler dev` still runs: emails are printed, not delivered.
