import { fetchDailySleep, fetchDailyReadiness, fetchDailySpO2 } from "../oura"
import { fetchActivities, fetchActivity, dateToUnix, type StravaActivity } from "../strava"
import { generateReport } from "../ai"

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

function getMondayOfWeek(today: string): string {
  const d = new Date(today + "T12:00:00Z")
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

function fmtDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-")
  return `${m}/${d}/${y}`
}

function scoreClass(score: number): string {
  if (score >= 85) return "score-great"
  if (score >= 70) return "score-good"
  return "score-low"
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtMiles(miles: unknown): string {
  if (typeof miles !== "number") return "—"
  return `${miles.toFixed(2)} mi`
}

function buildScoreHtml(label: string, score: number): string {
  const cls = scoreClass(score)
  return `<div class="metric"><span class="metric-label">${label}</span><span class="metric-value ${cls}">${score}</span></div>`
}

function buildActivityRow(a: StravaActivity): string {
  const name = String(a["name"] ?? "Activity")
  const type = String(a["sport_type"] ?? a["type"] ?? "")
  const miles = fmtMiles(a["distance_miles"])
  const dur = typeof a["moving_time"] === "number" ? fmtDuration(a["moving_time"]) : "—"
  const hr =
    typeof a["average_heartrate"] === "number" ? `${Math.round(a["average_heartrate"])} bpm` : "—"
  const watts = typeof a["average_watts"] === "number" ? `${Math.round(a["average_watts"])}w` : "—"
  return `<tr><td>${name}</td><td class="col-hide">${type}</td><td>${miles}</td><td>${dur}</td><td>${hr}</td><td class="col-hide">${watts}</td></tr>`
}

export async function buildMorningReport(
  env: Env,
  today: string,
): Promise<{ subject: string; html: string }> {
  const monday = getMondayOfWeek(today)
  const yesterday = (() => {
    const d = new Date(today + "T12:00:00Z")
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  })()

  // Fetch from yesterday if it predates the week start (e.g. today is Monday → yesterday is Sunday)
  const fetchFrom = yesterday < monday ? yesterday : monday

  const [sleepResp, readinessResp, spo2Resp, allActivities] = await Promise.all([
    fetchDailySleep(env.OURA_API_TOKEN, monday, today),
    fetchDailyReadiness(env.OURA_API_TOKEN, monday, today),
    fetchDailySpO2(env.OURA_API_TOKEN, yesterday, today),
    fetchActivities(env, dateToUnix(fetchFrom), dateToUnix(today, true)),
  ])

  // Week activities only (Monday onwards) — used for weekly summary
  const weekActivities = allActivities.filter((a) => {
    const startDate = String(a["start_date_local"] ?? "").slice(0, 10)
    return startDate >= monday
  })

  const todaySleep = sleepResp.data.find((d) => d["day"] === today)
  const todayReadiness = readinessResp.data.find((d) => d["day"] === today)
  const latestSpo2 = spo2Resp.data.slice(-1)[0]

  const sleepScore = typeof todaySleep?.["score"] === "number" ? todaySleep["score"] : null
  const readinessScore =
    typeof todayReadiness?.["score"] === "number" ? todayReadiness["score"] : null
  const spo2Percentage = latestSpo2?.["spo2_percentage"] as Record<string, unknown> | undefined
  const spo2Avg =
    spo2Percentage != null && typeof spo2Percentage["average"] === "number"
      ? (spo2Percentage["average"] as number)
      : null

  const contributors = (readinessResp.data.find((d) => d["day"] === today)?.["contributors"] ??
    {}) as Record<string, number>

  const yesterdayActivities = allActivities.filter((a) => {
    const startDate = String(a["start_date_local"] ?? "").slice(0, 10)
    return startDate === yesterday
  })

  const detailedYesterday: StravaActivity[] = await Promise.all(
    yesterdayActivities.map((a) =>
      typeof a["id"] === "number" ? fetchActivity(env, a["id"]) : Promise.resolve(a),
    ),
  )

  const topContributors = Object.entries(contributors)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join(", ")

  const weekTrendRows = sleepResp.data
    .map((s) => {
      const day = String(s["day"] ?? "")
      const ss = typeof s["score"] === "number" ? s["score"] : null
      const rs = readinessResp.data.find((r) => r["day"] === day)
      const readScore = typeof rs?.["score"] === "number" ? rs["score"] : null
      return `<tr><td>${fmtDate(day)}</td><td>${ss !== null ? `<span class="${scoreClass(ss)}">${ss}</span>` : "—"}</td><td>${readScore !== null ? `<span class="${scoreClass(readScore)}">${readScore}</span>` : "—"}</td></tr>`
    })
    .join("\n")

  const weekTotalMiles = weekActivities.reduce<number>((sum, a) => {
    return sum + (typeof a["distance_miles"] === "number" ? a["distance_miles"] : 0)
  }, 0)

  const weekTotalTime = weekActivities.reduce<number>((sum, a) => {
    return sum + (typeof a["moving_time"] === "number" ? a["moving_time"] : 0)
  }, 0)

  const systemPrompt = `You are an enthusiastic AI training assistant helping an endurance athlete meet their goals.
Your role is to provide a clear, energetic morning briefing that sets the tone for the day.
Write in an encouraging, direct tone — like a knowledgeable coach who's invested in the athlete's success.
Output a single HTML fragment: one <div class="verdict"> containing 2–3 <p> tags.
Structure: (1) brief recovery summary referencing the actual scores, (2) recap of yesterday's training if any, (3) a clear recommendation for today's training intensity — e.g. "Go hard today", "Easy effort only", "Rest day recommended" — with a one-sentence rationale.
To color-code a number inline, wrap it in a <span>: <span class="score-great">87</span> (≥85), <span class="score-good">75</span> (70–84), <span class="score-low">62</span> (<70).
Do NOT use metric, metric-label, or metric-value classes — those are already rendered above your section.
Be concise but specific. Reference the actual numbers. Keep total length under 150 words.`

  const dataSummary = `
DATE: ${today}
SLEEP SCORE: ${sleepScore ?? "N/A"}
READINESS SCORE: ${readinessScore ?? "N/A"}
SPO2 AVERAGE: ${spo2Avg !== null ? `${spo2Avg.toFixed(1)}%` : "N/A"}
TOP READINESS CONTRIBUTORS: ${topContributors || "N/A"}

YESTERDAY'S STRAVA ACTIVITIES (${yesterday}):
${
  detailedYesterday.length === 0
    ? "Rest day — no Strava activities recorded."
    : detailedYesterday
        .map((a) => {
          const np =
            typeof a["weighted_average_watts"] === "number"
              ? ` NP: ${a["weighted_average_watts"]}w`
              : ""
          const hr =
            typeof a["average_heartrate"] === "number"
              ? ` Avg HR: ${Math.round(a["average_heartrate"])} bpm`
              : ""
          const max =
            typeof a["max_heartrate"] === "number"
              ? ` Max HR: ${Math.round(a["max_heartrate"])} bpm`
              : ""
          const watts =
            typeof a["average_watts"] === "number"
              ? ` Avg Power: ${Math.round(a["average_watts"])}w`
              : ""
          const miles = fmtMiles(a["distance_miles"])
          const dur = typeof a["moving_time"] === "number" ? fmtDuration(a["moving_time"]) : "—"
          return `- ${String(a["name"] ?? "Activity")} (${String(a["sport_type"] ?? a["type"] ?? "")}) | ${miles} | ${dur}${hr}${max}${watts}${np}`
        })
        .join("\n")
}

WEEK SO FAR (${monday} – ${today}):
Activities: ${weekActivities.length}
Total distance: ${weekTotalMiles.toFixed(2)} miles
Total time: ${fmtDuration(weekTotalTime)}
Activity breakdown:
${weekActivities.map((a) => `- ${String(a["name"] ?? "")} | ${fmtMiles(a["distance_miles"])} | ${typeof a["moving_time"] === "number" ? fmtDuration(a["moving_time"]) : "—"}`).join("\n")}
`

  const aiHtml = await generateReport(env.AI, systemPrompt, dataSummary)

  const recoveryBadges = [
    sleepScore !== null ? buildScoreHtml("Sleep Score", sleepScore) : "",
    readinessScore !== null ? buildScoreHtml("Readiness Score", readinessScore) : "",
    spo2Avg !== null
      ? `<div class="metric"><span class="metric-label">SpO₂ Avg</span><span class="metric-value">${spo2Avg.toFixed(1)}%</span></div>`
      : "",
  ]
    .filter(Boolean)
    .join("")

  const html = `
<h1>🌅 Morning Report — ${fmtDate(today)}</h1>

<h2>Recovery</h2>
<div>${recoveryBadges}</div>
${topContributors ? `<p style="margin-top:10px;font-size:13px;color:#6b7280;">Contributors: ${topContributors}</p>` : ""}

<h2>Sleep & Readiness Trend</h2>
<div class="table-wrap"><table>
  <thead><tr><th>Date</th><th>Sleep</th><th>Readiness</th></tr></thead>
  <tbody>${weekTrendRows}</tbody>
</table></div>

${
  detailedYesterday.length > 0
    ? `<h2>Yesterday's Training</h2>
<div class="table-wrap"><table>
  <thead><tr><th>Activity</th><th class="col-hide">Type</th><th>Distance</th><th>Duration</th><th>Avg HR</th><th class="col-hide">Avg Power</th></tr></thead>
  <tbody>${detailedYesterday.map(buildActivityRow).join("\n")}</tbody>
</table></div>`
    : "<h2>Yesterday</h2><p>Rest day — no activities recorded.</p>"
}

${
  weekActivities.length > 0
    ? `<h2>Week So Far</h2>
<p><strong>${weekActivities.length} activities</strong> · ${weekTotalMiles.toFixed(2)} mi · ${fmtDuration(weekTotalTime)}</p>
<div class="table-wrap"><table>
  <thead><tr><th>Activity</th><th class="col-hide">Type</th><th>Distance</th><th>Duration</th><th>Avg HR</th><th class="col-hide">Avg Power</th></tr></thead>
  <tbody>${weekActivities.map(buildActivityRow).join("\n")}</tbody>
</table></div>`
    : ""
}

<h2>Today's Verdict</h2>
${aiHtml}
`

  const readLabel =
    readinessScore !== null
      ? readinessScore >= 85
        ? "🟢 High"
        : readinessScore >= 70
          ? "🟡 Moderate"
          : "🔴 Low"
      : ""
  const subject = `Morning Report ${fmtDate(today)}${readLabel ? ` — Readiness ${readLabel} (${readinessScore})` : ""}`

  return { subject, html }
}
