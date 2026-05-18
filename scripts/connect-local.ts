import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

import { banner, c, ok, warn, info, closePrompts, prompt, promptHidden } from "./prompts"
import { loadDevVars, saveDevVars } from "./utils"
import { runStravaOAuth } from "./strava-auth"

const DEV_VARS_PATH = path.resolve(process.cwd(), ".dev.vars")
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc")
const OURA_DEV_VARS_PATH = path.resolve(process.env["HOME"] ?? "", "Dev/oura-mcp-server/.dev.vars")
const STRAVA_DEV_VARS_PATH = path.resolve(
  process.env["HOME"] ?? "",
  "Dev/strava-mcp-server/.dev.vars",
)

async function main() {
  banner("health-reporting — Local setup", [
    "Sets up local credentials for local dev.",
    "No Cloudflare account needed — just keep `pnpm dev` running.",
  ])

  const vars = loadDevVars(DEV_VARS_PATH)

  // Oura API token — auto-detect from oura-mcp-server
  let ouraToken = vars["OURA_API_TOKEN"] ?? ""
  if (!ouraToken) {
    const ouraVars = loadDevVars(OURA_DEV_VARS_PATH)
    ouraToken = ouraVars["OURA_API_TOKEN"] ?? ""
    if (ouraToken) {
      info(`Auto-detected OURA_API_TOKEN from ${OURA_DEV_VARS_PATH}`)
    }
  }
  if (!ouraToken) {
    console.log(`\n  ${c.bold("Oura Personal Access Token")}`)
    console.log(`  ${c.dim("Get one at: https://cloud.ouraring.com/personal-access-tokens")}`)
    ouraToken = await promptHidden("Oura API Token (hidden)")
    if (!ouraToken) throw new Error("Oura API token cannot be empty")
  } else {
    ok("OURA_API_TOKEN found")
  }
  saveDevVars(DEV_VARS_PATH, { OURA_API_TOKEN: ouraToken })

  // Strava credentials — auto-detect from strava-mcp-server
  let clientId = vars["STRAVA_CLIENT_ID"] ?? ""
  let clientSecret = vars["STRAVA_CLIENT_SECRET"] ?? ""
  if (!clientId || !clientSecret) {
    const stravaVars = loadDevVars(STRAVA_DEV_VARS_PATH)
    if (!clientId) clientId = stravaVars["STRAVA_CLIENT_ID"] ?? ""
    if (!clientSecret) clientSecret = stravaVars["STRAVA_CLIENT_SECRET"] ?? ""
    if (clientId && clientSecret) {
      info(`Auto-detected Strava credentials from ${STRAVA_DEV_VARS_PATH}`)
    }
  }
  if (!clientId || !clientSecret) {
    console.log(`\n  ${c.bold("Strava API credentials")}`)
    console.log(`  ${c.dim("Get them from: https://www.strava.com/settings/api")}`)
    console.log(
      `  ${c.dim("Required: set Authorization Callback Domain to")} ${c.cyan("localhost")}\n`,
    )
    if (!clientId) {
      clientId = await promptHidden("Client ID (hidden)")
      if (!clientId) throw new Error("Client ID cannot be empty")
    }
    if (!clientSecret) {
      clientSecret = await promptHidden("Client Secret (hidden)")
      if (!clientSecret) throw new Error("Client Secret cannot be empty")
    }
  } else {
    ok("Strava credentials found")
  }
  saveDevVars(DEV_VARS_PATH, { STRAVA_CLIENT_ID: clientId, STRAVA_CLIENT_SECRET: clientSecret })

  // Strava OAuth flow → refresh token
  console.log(`\n  ${c.bold("Strava authorization")} — connecting to your Strava account`)
  const tokens = await runStravaOAuth(clientId, clientSecret)
  ok("Strava tokens obtained")
  saveDevVars(DEV_VARS_PATH, { STRAVA_REFRESH_TOKEN: tokens.refreshToken })
  ok("STRAVA_REFRESH_TOKEN saved to .dev.vars")

  // Resend API key
  let resendKey = vars["RESEND_API_KEY"] ?? ""
  if (!resendKey) {
    console.log(`\n  ${c.bold("Resend API key")}`)
    resendKey = await promptHidden("Resend API Key (hidden)")
    if (!resendKey) throw new Error("Resend API key cannot be empty")
    saveDevVars(DEV_VARS_PATH, { RESEND_API_KEY: resendKey })
    ok("RESEND_API_KEY saved to .dev.vars")
  } else {
    ok("RESEND_API_KEY already in .dev.vars")
  }

  // Report recipient
  let recipient = vars["REPORT_RECIPIENT"] ?? ""
  if (!recipient) {
    recipient = await prompt("Report recipient email", "loganmurphy1984@gmail.com")
    if (!recipient) throw new Error("Report recipient cannot be empty")
    saveDevVars(DEV_VARS_PATH, { REPORT_RECIPIENT: recipient })
    ok(`REPORT_RECIPIENT saved to .dev.vars`)
  } else {
    ok("REPORT_RECIPIENT already in .dev.vars")
  }

  // Report from address
  let fromAddress = vars["REPORT_FROM"] ?? ""
  if (!fromAddress) {
    fromAddress = await prompt("Report from address", "reports@loganmurphy.dev")
    if (!fromAddress) throw new Error("Report from address cannot be empty")
    saveDevVars(DEV_VARS_PATH, { REPORT_FROM: fromAddress })
    ok(`REPORT_FROM saved to .dev.vars`)
  } else {
    ok("REPORT_FROM already in .dev.vars")
  }

  // wrangler.jsonc setup
  if (!fs.existsSync(WRANGLER_JSONC_PATH)) {
    const example = path.resolve(process.cwd(), "wrangler.example.jsonc")
    if (!fs.existsSync(example))
      throw new Error("wrangler.jsonc not found and wrangler.example.jsonc is missing")
    fs.copyFileSync(example, WRANGLER_JSONC_PATH)
    ok("Created wrangler.jsonc from example")
  } else {
    ok("wrangler.jsonc found")
  }

  // Regenerate Worker types
  info("Regenerating Worker types...")
  const typegen = spawnSync("npx", ["wrangler", "types"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  })
  if (typegen.status !== 0) warn("Type generation failed — run `pnpm cf-typegen` manually")
  else ok("worker-configuration.d.ts updated")

  console.log()
  ok("Local setup complete!")
  console.log()
  console.log(`  ${c.bold("Next steps:")}`)
  console.log(`  ${c.dim("1.")} Run ${c.cyan("pnpm dev")} to start the local Worker`)
  console.log(
    `  ${c.dim("2.")} Trigger a scheduled run: ${c.cyan("npx wrangler dev --test-scheduled")}`,
  )
  console.log()
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`\n${c.red("✗")} ${msg}`)
    process.exit(1)
  })
  .finally(() => closePrompts())
