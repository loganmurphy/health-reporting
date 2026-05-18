# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start local dev server on http://localhost:8787 (Miniflare, hot reload)
pnpm deploy       # Deploy to Cloudflare Workers (requires wrangler login)
pnpm cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.jsonc bindings
pnpm bootstrap    # Interactive wizard — provisions KV, runs Strava OAuth, deploys Worker
pnpm setup        # Local dev setup — writes credentials to .dev.vars, copies wrangler.jsonc
pnpm format       # Prettier (write)
pnpm format:check # Prettier (check only — used by pre-commit hook)
pnpm lint         # oxlint
pnpm test         # Vitest unit tests
pnpm coverage     # Vitest + v8 coverage (≥90% threshold)
npx tsc --noEmit -p tsconfig.scripts.json   # Type-check scripts
npx tsc --noEmit                             # Type-check the Worker
```

## Code style

Prettier enforces formatting on every commit (`pnpm format:check` runs in the pre-commit hook). Config: no semis, trailing commas, 100-char print width. Run `pnpm format` to auto-fix before committing.

No section-header comments (`// ── Foo ────`). Comments only where behavior is non-obvious.

Pre-commit hooks are managed by **lefthook** (`lefthook.yml`). They run lint + both typechecks in parallel before every commit.

`wrangler.jsonc` is gitignored — copy from the template:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Local secrets live in `.dev.vars` (gitignored). `.dev.vars.example` documents all required vars.

Bootstrap state (Cloudflare account ID, KV namespace ID) lives in `.bootstrap-state` (gitignored).

## Architecture

There is no build step. Wrangler bundles `src/index.ts` directly via esbuild on `dev`/`deploy`.

### Cron triggers

Two cron triggers are configured by `pnpm setup` or `pnpm bootstrap`. Both scripts prompt for:

- Morning report time (HH:MM local, 24h)
- Evening report time (HH:MM local, 24h)
- UTC offset (signed integer, e.g. -6 for MDT)

The cron strings are generated via `localTimeToCron()` in `scripts/utils.ts` and written to `wrangler.jsonc` in two places:

- `triggers.crons` — the Cloudflare cron schedule
- `vars.MORNING_CRON` / `vars.EVENING_CRON` — read by the Worker at runtime

The Worker's `scheduled` handler dispatches to `buildMorningReport` or `buildEveningReport` by comparing `event.cron` against `env.MORNING_CRON`.

### No OAuth layer

Unlike the MCP servers, this Worker has no user-facing HTTP routes. All requests are cron-triggered. The only HTTP traffic is outbound API calls to Oura, Strava, Workers AI, and Resend.

### Strava token rotation (`src/strava.ts`)

Strava access tokens expire every 6 hours. `getAccessToken()` checks `OAUTH_KV` for a cached token, refreshes via the Strava token endpoint if expired, and writes the new tokens back to KV. `STRAVA_REFRESH_TOKEN` is set as a Worker secret as a fallback for the first run (before KV has tokens).

### Oura API (`src/oura.ts`)

Thin fetch wrapper for five Oura endpoints: `daily_sleep`, `daily_readiness`, `daily_spo2`, `workout`, `daily_activity`. Auth via `Authorization: Bearer {OURA_API_TOKEN}`. Retries on 429/5xx.

### Workers AI (`src/ai.ts`)

Uses `@cf/meta/llama-3.3-70b-instruct`. Takes a system prompt and user content (pre-formatted data summary), returns the text response with markdown fences stripped.

### Email (`src/email.ts`)

Posts to the Resend API (`https://api.resend.com/emails`). The HTML fragment from the AI is wrapped in a full email template (white card on `#f3f4f6` background, `600px` max-width, `border-radius:12px`).

### Report builders

- `src/reports/morning.ts` — assembles readiness/sleep/SpO₂ data, yesterday's Strava activities (with full detail fetch), week trend, then asks Workers AI for a training verdict.
- `src/reports/evening.ts` — assembles today's Strava activities (with full detail fetch), Oura daily activity summary, week totals, then asks Workers AI for a day recap.

Both builders fetch detailed activity data individually (one API call per activity) after the initial list fetch, to get power data, suffer score, HR zones, etc.

### Bootstrap (`scripts/bootstrap.ts`)

Authenticates to Cloudflare via `wrangler login`. Provisions a KV namespace for Strava token rotation, writes `wrangler.jsonc`, runs the Strava OAuth flow (via `scripts/strava-auth.ts`), prompts for Oura/Resend credentials, deploys the Worker, and sets all secrets.
