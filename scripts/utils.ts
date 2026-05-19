import * as fs from "node:fs"
import { spawnSync } from "node:child_process"

export function loadDevVars(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {}
  if (!fs.existsSync(filePath)) return vars
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return vars
}

export function saveDevVars(filePath: string, vars: Record<string, string>): void {
  const existing = loadDevVars(filePath)
  const merged = { ...existing, ...vars }
  const content =
    Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  fs.writeFileSync(filePath, content)
}

/** Open a URL in the default browser (best-effort, silent on failure). */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", url] : [url]
  spawnSync(cmd, args, { stdio: "ignore" })
}

/**
 * Update `triggers.crons` and `vars.MORNING_CRON` / `vars.EVENING_CRON` in a wrangler.jsonc file.
 * Operates on the raw text so comments (JSONC) are preserved.
 */
export function updateWranglerCrons(
  filePath: string,
  morningCron: string,
  eveningCron: string,
  utcOffset: number,
): void {
  let text = fs.readFileSync(filePath, "utf8")

  // Replace triggers.crons array
  text = text.replace(/"crons":\s*\[[^\]]*\]/, `"crons": ["${morningCron}", "${eveningCron}"]`)

  // Replace or add MORNING_CRON in vars block
  if (/"MORNING_CRON"\s*:/.test(text)) {
    text = text.replace(/"MORNING_CRON"\s*:\s*"[^"]*"/, `"MORNING_CRON": "${morningCron}"`)
  } else {
    text = text.replace(/("vars"\s*:\s*\{)/, `$1\n    "MORNING_CRON": "${morningCron}",`)
  }

  // Replace or add EVENING_CRON in vars block
  if (/"EVENING_CRON"\s*:/.test(text)) {
    text = text.replace(/"EVENING_CRON"\s*:\s*"[^"]*"/, `"EVENING_CRON": "${eveningCron}"`)
  } else {
    text = text.replace(/("vars"\s*:\s*\{)/, `$1\n    "EVENING_CRON": "${eveningCron}",`)
  }

  // Replace or add UTC_OFFSET in vars block
  if (/"UTC_OFFSET"\s*:/.test(text)) {
    text = text.replace(/"UTC_OFFSET"\s*:\s*"[^"]*"/, `"UTC_OFFSET": "${utcOffset}"`)
  } else {
    text = text.replace(/("vars"\s*:\s*\{)/, `$1\n    "UTC_OFFSET": "${utcOffset}",`)
  }

  fs.writeFileSync(filePath, text)
}

/**
 * Convert a local HH:MM time and UTC offset to a cron string (UTC).
 * @param localTime - "HH:MM" in 24h format
 * @param utcOffset - signed integer (e.g. -6 for MDT, 0 for UTC, +1 for BST)
 */
export function localTimeToCron(localTime: string, utcOffset: number): string {
  const [hourStr, minStr] = localTime.split(":")
  const localHour = parseInt(hourStr!, 10)
  const localMin = parseInt(minStr!, 10)
  const utcHour = (((localHour - utcOffset) % 24) + 24) % 24
  return `${localMin} ${utcHour} * * *`
}

/** Copy text to the system clipboard (best-effort, silent on failure). */
export function copyToClipboard(text: string): boolean {
  const cmd =
    process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip"
  const args = process.platform === "linux" ? ["-selection", "clipboard"] : []
  const result = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] })
  return result.status === 0
}
