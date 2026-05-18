# health-reporting

[![CI](https://img.shields.io/github/actions/workflow/status/loganmurphy/health-reporting/ci.yml?label=CI)](https://github.com/loganmurphy/health-reporting/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Twice-daily health and training digest delivered to your inbox. Combines Oura ring and Strava data, generates a personalised HTML report via Cloudflare Workers AI, and sends via [Resend](https://resend.com). Runs entirely on Cloudflare Workers — no server, no cron, no macOS required.

## Reports

**Morning (9:30 AM)** — starts the day with a full recovery and training picture:

- Recovery scores (readiness, sleep, SpO₂) with color-coded indicators
- Sleep and readiness trend for the current week
- Yesterday's training — distance, duration, HR, power
- Week so far — activity list with running totals
- Verdict — AI training recommendation based on recovery

**Evening (8:00 PM)** — closes the day with a training recap:

- Today's Strava activities in detail (power, normalized power, HR, suffer score)
- Oura daily activity summary (steps, calories, activity score)
- Week so far — updated totals
- Day recap — AI analysis of what was accomplished and how the week is tracking

## Architecture

```
Cloudflare Cron Trigger (2× daily)
  └─ Worker
       ├─ Oura API          sleep, readiness, SpO₂, activity, workouts
       ├─ Strava API         activities + per-activity detail, token auto-refresh
       ├─ Workers AI         @cf/meta/llama-3.3-70b-instruct — HTML report generation
       └─ Resend API         email delivery → reports@yourdomain.com → you@email.com
```

No inbound HTTP — the Worker returns 404 for all external requests. All traffic is outbound.

KV is used only for Strava access/refresh token rotation (tokens expire every 6 hours).

## Requirements

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier)
- [Oura Ring](https://ouraring.com) with a Personal Access Token
- [Strava](https://www.strava.com/settings/api) API application — set Authorization Callback Domain to `localhost`
- [Resend](https://resend.com) account + verified sending domain + API key
- Node.js 24, pnpm 10 — [Volta](https://volta.sh) recommended

## Bootstrap

```bash
pnpm install
pnpm bootstrap
```

The wizard handles everything:

1. Sign in to Cloudflare via `wrangler login`
2. Select your account
3. Create KV namespace for Strava token rotation
4. Prompt for Oura PAT, Strava credentials, Resend API key, email addresses
5. Run Strava OAuth flow
6. Deploy the Worker and set all secrets

Re-running is fully idempotent.

### Local dev first?

```bash
pnpm setup-local    # writes credentials to .dev.vars, copies wrangler.jsonc
pnpm dev      # http://localhost:8787
```

Test a scheduled trigger locally (use the cron values from `.dev.vars`):

```bash
curl "http://localhost:8787/__scheduled?cron=<MORNING_CRON_URL_ENCODED>"   # morning
curl "http://localhost:8787/__scheduled?cron=<EVENING_CRON_URL_ENCODED>"   # evening
```

## Cron schedule

Cron times are configured during `pnpm setup-local` or `pnpm bootstrap`. Both wizards prompt for your local report times and UTC offset, then convert to UTC cron automatically. The generated cron strings are stored in `wrangler.jsonc` under both `triggers.crons` and `vars`.

| Trigger                           | UTC                          | Report  |
| --------------------------------- | ---------------------------- | ------- |
| `MORNING_CRON` (set during setup) | e.g. `30 15 * * *` for UTC-6 | Morning |
| `EVENING_CRON` (set during setup) | e.g. `0 2 * * *` for UTC-6   | Evening |

To test locally with your configured crons:

```bash
curl "http://localhost:8787/__scheduled?cron=<MORNING_CRON>"   # morning
curl "http://localhost:8787/__scheduled?cron=<EVENING_CRON>"   # evening
```

## Related

- [oura-mcp-server](https://github.com/loganmurphy/oura-mcp-server) — Oura Ring data as MCP tools for Claude
- [strava-mcp-server](https://github.com/loganmurphy/strava-mcp-server) — Strava data as MCP tools for Claude
