import * as fs from "node:fs"
import * as path from "node:path"
import { spawn, spawnSync } from "node:child_process"

import {
  banner,
  c,
  confirm,
  closePrompts,
  info,
  ok,
  pick,
  prompt,
  promptHidden,
  pressEnter,
  step,
  warn,
} from "./prompts"
import {
  loadDevVars,
  openBrowser,
  saveDevVars,
  localTimeToCron,
  updateWranglerCrons,
} from "./utils"
import { runStravaOAuth } from "./strava-auth"

const WORKER_NAME = "health-reporting"
const KV_NAME = "health-reporting-kv"
const STRAVA_API_URL = "https://www.strava.com/settings/api"

const DEV_VARS_PATH = path.resolve(process.cwd(), ".dev.vars")
const BOOTSTRAP_STATE_PATH = path.resolve(process.cwd(), ".bootstrap-state")
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc")
const WRANGLER_EXAMPLE_PATH = path.resolve(process.cwd(), "wrangler.example.jsonc")

function wranglerWhoami(): { email: string; accounts: { id: string; name: string }[] } | null {
  const result = spawnSync("npx", ["wrangler", "whoami"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
  const out = (result.stdout ?? "") + (result.stderr ?? "")
  if (result.status !== 0 || out.includes("not authenticated")) return null

  const email = out.match(/associated with the email\s+(\S+)/)?.[1] ?? "unknown"
  const accounts: { id: string; name: string }[] = []
  for (const m of out.matchAll(/│\s+(.+?)\s+│\s+([0-9a-f]{32})\s+│/g)) {
    accounts.push({ name: m[1]!.trim(), id: m[2]!.trim() })
  }
  return { email, accounts }
}

async function ensureWranglerAuth(): Promise<{ accountId: string; accountName: string }> {
  step(1, "Connect to Cloudflare")

  let whoami = wranglerWhoami()
  if (whoami) {
    ok(`Already signed in as ${c.cyan(whoami.email)}`)
  } else {
    info("Opening Cloudflare sign-in in your browser...")
    console.log(`  ${c.dim("No account yet? You can create a free one during this step.")}`)
    await new Promise<void>((resolve, reject) => {
      loginChild = spawn("npx", ["wrangler", "login"], { stdio: "inherit" })
      loginChild.on("exit", (code) => {
        loginChild = null
        if (code !== 0) reject(new Error("`wrangler login` was cancelled or failed"))
        else resolve()
      })
      loginChild.on("error", (err) => {
        loginChild = null
        reject(err)
      })
    })

    whoami = wranglerWhoami()
    if (!whoami)
      throw new Error(
        "Could not verify Cloudflare credentials after login.\n" +
          `  Fallback: set ${c.cyan("CLOUDFLARE_API_TOKEN")} in your environment and re-run.`,
      )
    ok(`Signed in as ${c.cyan(whoami.email)}`)
  }

  return pickAccount(whoami.accounts)
}

async function pickAccount(
  accounts: { id: string; name: string }[],
): Promise<{ accountId: string; accountName: string }> {
  step(2, "Select Cloudflare account")

  if (accounts.length === 0)
    throw new Error("No Cloudflare accounts found — try `wrangler login` again")

  const saved =
    loadDevVars(BOOTSTRAP_STATE_PATH)["CLOUDFLARE_ACCOUNT_ID"] ??
    process.env["CLOUDFLARE_ACCOUNT_ID"]
  if (saved) {
    const match = accounts.find((a) => a.id === saved)
    if (match) {
      info(`Using saved account — ${c.cyan(match.name)}`)
      console.log(`  ${c.dim("(Run `pnpm reset` to clear saved state and switch accounts.)")}`)
      return { accountId: match.id, accountName: match.name }
    }
    warn("Saved account ID not found — prompting below.")
  }

  let selected: { id: string; name: string }
  if (accounts.length === 1) {
    selected = accounts[0]!
    ok(`Using ${c.cyan(selected.name)} ${c.dim(`(${selected.id})`)}`)
  } else {
    const idx = await pick(
      "You have multiple accounts — which one?",
      accounts,
      (a) => `${a.name} ${c.dim(`(${a.id})`)}`,
      0,
    )
    selected = accounts[idx]!
    ok(`Using ${c.cyan(selected.name)}`)
  }

  saveDevVars(BOOTSTRAP_STATE_PATH, { CLOUDFLARE_ACCOUNT_ID: selected.id })
  return { accountId: selected.id, accountName: selected.name }
}

function ensureKvNamespace(accountId: string): string {
  step(3, "KV namespace for Strava token rotation")

  const listResult = spawnSync("npx", ["wrangler", "kv", "namespace", "list"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (listResult.status === 0 && listResult.stdout?.trim()) {
    const namespaces = JSON.parse(listResult.stdout) as { id: string; title: string }[]
    const existing = namespaces.find((ns) => ns.title === KV_NAME)
    if (existing?.id) {
      ok(`Found existing KV namespace ${c.cyan(KV_NAME)}`)
      return existing.id
    }
  }

  info(`Creating KV namespace "${KV_NAME}"...`)
  const createResult = spawnSync("npx", ["wrangler", "kv", "namespace", "create", KV_NAME], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (createResult.status !== 0) throw new Error(`KV create failed: ${createResult.stderr?.trim()}`)

  const id = createResult.stdout.match(/"id":\s*"([^"]+)"/)?.[1]
  if (!id) throw new Error("KV create succeeded but couldn't parse the namespace ID")
  ok(`Created KV namespace ${c.cyan(KV_NAME)} ${c.dim(`(${id})`)}`)
  return id
}

function writeWranglerConfig(
  kvNamespaceId: string,
  morningCron: string,
  eveningCron: string,
  utcOffset: number,
): void {
  step(4, "Local Worker config (wrangler.jsonc)")

  if (!fs.existsSync(WRANGLER_EXAMPLE_PATH)) throw new Error(`Missing ${WRANGLER_EXAMPLE_PATH}`)
  const out = fs
    .readFileSync(WRANGLER_EXAMPLE_PATH, "utf8")
    .replace(/YOUR_KV_NAMESPACE_ID/g, kvNamespaceId)
  fs.writeFileSync(WRANGLER_JSONC_PATH, out)
  updateWranglerCrons(WRANGLER_JSONC_PATH, morningCron, eveningCron, utcOffset)
  ok(`Wrote wrangler.jsonc ${c.dim(`(KV: ${kvNamespaceId.slice(0, 8)}…)`)}`)
}

async function ensureStravaCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  step(5, "Strava API credentials")

  const vars = loadDevVars(DEV_VARS_PATH)
  let clientId = vars["STRAVA_CLIENT_ID"] ?? ""
  let clientSecret = vars["STRAVA_CLIENT_SECRET"] ?? ""

  if (clientId && clientSecret) {
    if (await confirm("Found existing Strava credentials in .dev.vars — use them?", true)) {
      ok("Reusing existing Strava credentials")
      return { clientId, clientSecret }
    }
  }

  console.log("  You need a Strava API application to connect this worker.")
  console.log(`  ${c.bold("Create one at:")} ${c.cyan(STRAVA_API_URL)}`)
  console.log(
    `  ${c.dim("Important: set Authorization Callback Domain to")} ${c.cyan("localhost")}\n`,
  )

  if (!(await confirm("Do you have a Strava API app already?", false))) {
    openBrowser(STRAVA_API_URL)
    await pressEnter("Press Enter once your Strava app is created...")
  }

  clientId = await promptHidden("Client ID (hidden)")
  if (!clientId) throw new Error("Client ID cannot be empty")

  clientSecret = await promptHidden("Client Secret (hidden)")
  if (!clientSecret) throw new Error("Client Secret cannot be empty")

  saveDevVars(DEV_VARS_PATH, { STRAVA_CLIENT_ID: clientId, STRAVA_CLIENT_SECRET: clientSecret })
  ok("Strava credentials saved to .dev.vars")
  return { clientId, clientSecret }
}

async function promptApiCredentials(): Promise<{
  ouraToken: string
  resendKey: string
  recipient: string
  fromAddress: string
  morningCron: string
  eveningCron: string
  utcOffset: number
}> {
  step(6, "API credentials")

  const vars = loadDevVars(DEV_VARS_PATH)

  console.log("  Enter your API credentials. All values are saved to .dev.vars (gitignored).\n")

  const ouraToken =
    vars["OURA_API_TOKEN"] && (await confirm("Found OURA_API_TOKEN — reuse it?", true))
      ? vars["OURA_API_TOKEN"]!
      : await promptHidden("Oura Personal Access Token (hidden)")
  if (!ouraToken) throw new Error("Oura API token cannot be empty")

  const resendKey =
    vars["RESEND_API_KEY"] && (await confirm("Found RESEND_API_KEY — reuse it?", true))
      ? vars["RESEND_API_KEY"]!
      : await promptHidden("Resend API Key (hidden)")
  if (!resendKey) throw new Error("Resend API key cannot be empty")

  const recipient = await prompt("Report recipient email", vars["REPORT_RECIPIENT"] ?? "")
  if (!recipient) throw new Error("Report recipient cannot be empty")

  const fromAddress = await prompt("Report from address", vars["REPORT_FROM"] ?? "")
  if (!fromAddress) throw new Error("Report from address cannot be empty")

  // Cron schedule
  let morningCron = vars["MORNING_CRON"] ?? ""
  let eveningCron = vars["EVENING_CRON"] ?? ""
  let utcOffset = parseInt(vars["UTC_OFFSET"] ?? "NaN", 10)
  if (!morningCron || !eveningCron || isNaN(utcOffset)) {
    console.log(`\n  ${c.bold("Cron schedule")}`)
    console.log(`  ${c.dim("Enter times in your local timezone (24h). Examples: 09:30, 20:00")}`)
    const morningTime = await prompt("Morning report time [HH:MM local, 24h]", "09:30")
    const eveningTime = await prompt("Evening report time [HH:MM local, 24h]", "20:00")
    const utcOffsetRaw = await prompt("UTC offset (e.g. -6 for MDT, 0 for UTC)", "0")
    utcOffset = parseInt(utcOffsetRaw, 10)
    if (isNaN(utcOffset)) throw new Error("UTC offset must be an integer")
    morningCron = localTimeToCron(morningTime, utcOffset)
    eveningCron = localTimeToCron(eveningTime, utcOffset)
    ok(`Morning cron: ${morningCron}  Evening cron: ${eveningCron}  UTC offset: ${utcOffset}`)
  } else {
    ok(`MORNING_CRON / EVENING_CRON / UTC_OFFSET already in .dev.vars`)
  }

  saveDevVars(DEV_VARS_PATH, {
    OURA_API_TOKEN: ouraToken,
    RESEND_API_KEY: resendKey,
    REPORT_RECIPIENT: recipient,
    REPORT_FROM: fromAddress,
    MORNING_CRON: morningCron,
    EVENING_CRON: eveningCron,
    UTC_OFFSET: String(utcOffset),
  })
  ok("Credentials saved to .dev.vars")

  return { ouraToken, resendKey, recipient, fromAddress, morningCron, eveningCron, utcOffset }
}

async function runDeploy(accountId: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "deploy"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    })

    let output = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      const t = chunk.toString()
      output += t
      process.stdout.write(t)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const t = chunk.toString()
      output += t
      process.stderr.write(t)
    })
    child.on("exit", (code) => resolve({ code, output }))
    child.on("error", reject)
  })
}

async function deployWorker(accountId: string): Promise<void> {
  step(7, "Deploy Worker to Cloudflare")

  for (let attempt = 1; attempt <= 2; attempt++) {
    info(
      attempt === 1
        ? "Running `wrangler deploy`... (first deploy takes ~20s)"
        : "Retrying deploy...",
    )

    const { code, output } = await runDeploy(accountId)

    if (code === 0) {
      const match = output.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/)
      ok(`Worker deployed → ${c.cyan(match?.[0] ?? WORKER_NAME + ".workers.dev")}`)
      return
    }

    if (attempt === 1 && output.includes("workers.dev subdomain")) {
      warn("Your Cloudflare account needs a workers.dev subdomain — required for first deploy.")
      openBrowser(`https://dash.cloudflare.com/${accountId}/workers`)
      await pressEnter("Press Enter once your subdomain is registered...")
      continue
    }

    throw new Error(`wrangler deploy failed (exit ${code})`)
  }
}

async function authorizeStrava(
  accountId: string,
  kvId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  step(8, "Authorize Strava")

  const tokens = await runStravaOAuth(clientId, clientSecret)
  ok("Strava tokens obtained")

  const accessTokenPayload = JSON.stringify({
    token: tokens.accessToken,
    expires_at: tokens.expiresAt,
  })
  const cfEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: "false" }

  const putAccess = spawnSync(
    "npx",
    [
      "wrangler",
      "kv",
      "key",
      "put",
      "strava:access_token",
      accessTokenPayload,
      "--namespace-id",
      kvId,
    ],
    { stdio: ["ignore", "inherit", "inherit"], env: cfEnv },
  )
  if (putAccess.status !== 0) throw new Error("Failed to write strava:access_token to KV")
  ok("strava:access_token written to KV")

  const putRefresh = spawnSync(
    "npx",
    [
      "wrangler",
      "kv",
      "key",
      "put",
      "strava:refresh_token",
      tokens.refreshToken,
      "--namespace-id",
      kvId,
    ],
    { stdio: ["ignore", "inherit", "inherit"], env: cfEnv },
  )
  if (putRefresh.status !== 0) throw new Error("Failed to write strava:refresh_token to KV")
  ok("strava:refresh_token written to KV")

  return tokens.refreshToken
}

function setWorkerSecrets(
  accountId: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  ouraToken: string,
  resendKey: string,
  recipient: string,
  fromAddress: string,
): void {
  step(9, "Set Worker secrets")

  for (const [name, value] of [
    ["STRAVA_CLIENT_ID", clientId],
    ["STRAVA_CLIENT_SECRET", clientSecret],
    ["STRAVA_REFRESH_TOKEN", refreshToken],
    ["OURA_API_TOKEN", ouraToken],
    ["RESEND_API_KEY", resendKey],
    ["REPORT_RECIPIENT", recipient],
    ["REPORT_FROM", fromAddress],
  ] as const) {
    const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
      input: value,
      stdio: ["pipe", "ignore", "inherit"],
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    })
    if (result.status !== 0) throw new Error(`Failed to set secret ${name}`)
    ok(`Secret ${c.cyan(name)} set`)
  }
}

let loginChild: import("node:child_process").ChildProcess | null = null

process.on("SIGINT", () => {
  if (loginChild) {
    try {
      loginChild.kill("SIGTERM")
    } catch {
      /* ignore */
    }
  }
  closePrompts()
  process.exit(130)
})

async function main(): Promise<void> {
  banner("health-reporting — Bootstrap", [
    "This will set up everything needed to send twice-daily",
    "health and training reports to your email.",
    "",
    "It creates (in your Cloudflare account):",
    "  • A KV namespace for Strava token rotation",
    "  • A Worker with two cron triggers",
    "",
    `${c.bold("You'll need:")}`,
    `  • A ${c.cyan("Cloudflare account")} — free, sign up during the login step`,
    `  • A ${c.cyan("Strava API application")} (strava.com/settings/api)`,
    `  • An ${c.cyan("Oura Personal Access Token")} (cloud.ouraring.com/personal-access-tokens)`,
    `  • A ${c.cyan("Resend API key")} (resend.com) with a verified sending domain`,
    "",
    `Cron schedule: configured during setup (local time + UTC offset).`,
    "",
    `Estimated time: ${c.bold("~5 minutes")}`,
  ])

  if (!(await confirm("Ready to start?", true))) {
    console.log("  Cancelled. Run again any time with `pnpm bootstrap`.")
    return
  }

  const { accountId } = await ensureWranglerAuth()

  step(2.5, "Check existing resources")
  const kvList = spawnSync("npx", ["wrangler", "kv", "namespace", "list"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  const kvs =
    kvList.status === 0 && kvList.stdout?.trim()
      ? (JSON.parse(kvList.stdout) as { title: string }[])
      : []
  const existingKv = kvs.some((ns) => ns.title === KV_NAME)

  console.log()
  banner("Ready to provision", [
    `Cloudflare account:  ${c.cyan(accountId)}`,
    "",
    `${c.bold("The following will happen:")}`,
    `  • KV namespace "${KV_NAME}" — ${existingKv ? c.dim("reuse existing") : c.green("create new")}`,
    `  • Deploy Worker "${WORKER_NAME}" (create on first run, update otherwise)`,
    `  • Authorize with Strava (browser OAuth flow)`,
    `  • Set all Worker secrets`,
  ])
  if (!(await confirm("Proceed?", true))) {
    console.log("  Cancelled — no changes were made.")
    return
  }

  const kvId = ensureKvNamespace(accountId)
  saveDevVars(BOOTSTRAP_STATE_PATH, { KV_NAMESPACE_ID: kvId })

  step(4.5, "Regenerate Worker types")
  info("Running `wrangler types`...")
  const typegen = spawnSync("npx", ["wrangler", "types"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (typegen.status !== 0) warn("Type generation failed — run `pnpm cf-typegen` manually")
  else ok("worker-configuration.d.ts updated")

  const { clientId, clientSecret } = await ensureStravaCredentials()
  const { ouraToken, resendKey, recipient, fromAddress, morningCron, eveningCron, utcOffset } =
    await promptApiCredentials()
  writeWranglerConfig(kvId, morningCron, eveningCron, utcOffset)
  await deployWorker(accountId)

  const refreshToken = await authorizeStrava(accountId, kvId, clientId, clientSecret)
  saveDevVars(DEV_VARS_PATH, { STRAVA_REFRESH_TOKEN: refreshToken })
  ok("STRAVA_REFRESH_TOKEN saved to .dev.vars")

  setWorkerSecrets(
    accountId,
    clientId,
    clientSecret,
    refreshToken,
    ouraToken,
    resendKey,
    recipient,
    fromAddress,
  )

  console.log()
  banner("✅  Setup complete!", [
    `Reports will be sent to: ${c.cyan(recipient)}`,
    "",
    `${c.bold("Schedule (UTC crons):")}`,
    `  • ${morningCron} — morning report (readiness, sleep trend, yesterday's training)`,
    `  • ${eveningCron} — evening report (today's training, day recap)`,
    "",
    `To test immediately: ${c.cyan("npx wrangler dev")} then trigger via Miniflare`,
    `To tail logs: ${c.cyan("npx wrangler tail")}`,
    `To redeploy: ${c.cyan("pnpm deploy")}`,
  ])
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`\n${c.red("✗ Setup failed:")} ${msg}`)
    process.exit(1)
  })
  .finally(() => closePrompts())
