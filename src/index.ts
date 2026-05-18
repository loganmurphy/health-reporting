import { buildMorningReport } from "./reports/morning"
import { buildEveningReport } from "./reports/evening"
import { sendEmail } from "./email"

interface Env {
  AI: Ai
  OAUTH_KV: KVNamespace
  OURA_API_TOKEN: string
  STRAVA_CLIENT_ID: string
  STRAVA_CLIENT_SECRET: string
  STRAVA_REFRESH_TOKEN: string
  RESEND_API_KEY: string
  REPORT_RECIPIENT: string
  REPORT_FROM: string
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 })
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    const isMorning = event.cron === "30 15 * * *"

    const { subject, html } = isMorning
      ? await buildMorningReport(env, today)
      : await buildEveningReport(env, today)

    await sendEmail(
      { apiKey: env.RESEND_API_KEY, from: env.REPORT_FROM, to: env.REPORT_RECIPIENT },
      subject,
      html,
    )
  },
}
