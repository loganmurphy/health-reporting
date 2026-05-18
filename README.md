# health-reporting

Cloudflare Worker that sends twice-daily health and training reports by combining Oura ring data and Strava activity data, generating HTML email content via Cloudflare Workers AI, and delivering via Resend.

## Setup

```bash
pnpm install
pnpm bootstrap
```

See `CLAUDE.md` for full documentation.
