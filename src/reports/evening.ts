import { fetchDailyActivity } from "../oura"
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

function buildActivityDetailHtml(a: StravaActivity): string {
  const name = String(a["name"] ?? "Activity")
  const type = String(a["sport_type"] ?? a["type"] ?? "")
  const miles = fmtMiles(a["distance_miles"])
  const dur = typeof a["moving_time"] === "number" ? fmtDuration(a["moving_time"]) : "—"
  const elev =
    typeof a["total_elevation_gain"] === "number"
      ? `${Math.round(a["total_elevation_gain"])}m elev`
      : null
  const avgHr =
    typeof a["average_heartrate"] === "number"
      ? `Avg HR: ${Math.round(a["average_heartrate"])} bpm`
      : null
  const maxHr =
    typeof a["max_heartrate"] === "number" ? `Max HR: ${Math.round(a["max_heartrate"])} bpm` : null
  const avgWatts =
    typeof a["average_watts"] === "number" ? `Avg Power: ${Math.round(a["average_watts"])}w` : null
  const np =
    typeof a["weighted_average_watts"] === "number" ? `NP: ${a["weighted_average_watts"]}w` : null
  const maxWatts =
    typeof a["max_watts"] === "number" ? `Max Power: ${Math.round(a["max_watts"])}w` : null
  const calories = typeof a["calories"] === "number" ? `${a["calories"]} kcal` : null
  const kudos = typeof a["kudos_count"] === "number" ? `${a["kudos_count"]} kudos` : null
  const suffer = typeof a["suffer_score"] === "number" ? `Suffer Score: ${a["suffer_score"]}` : null

  const stats = [miles, dur, elev, avgHr, maxHr, avgWatts, np, maxWatts, calories, kudos, suffer]
    .filter(Boolean)
    .map((stat) => `<li>${stat}</li>`)
    .join("")

  const desc = typeof a["description"] === "string" && a["description"] ? a["description"] : null

  return `<h3>${name} <span style="font-weight:400;color:#6b7280;">${type}</span></h3>
<ul>${stats}</ul>
${desc ? `<p style="font-size:13px;color:#374151;font-style:italic;">"${desc}"</p>` : ""}`
}

function buildWeekRow(a: StravaActivity): string {
  const name = String(a["name"] ?? "Activity")
  const type = String(a["sport_type"] ?? a["type"] ?? "")
  const miles = fmtMiles(a["distance_miles"])
  const dur = typeof a["moving_time"] === "number" ? fmtDuration(a["moving_time"]) : "—"
  const hr =
    typeof a["average_heartrate"] === "number" ? `${Math.round(a["average_heartrate"])} bpm` : "—"
  const watts = typeof a["average_watts"] === "number" ? `${Math.round(a["average_watts"])}w` : "—"
  const startDate = String(a["start_date_local"] ?? "").slice(0, 10)
  return `<tr><td>${startDate}</td><td>${name}</td><td>${type}</td><td>${miles}</td><td>${dur}</td><td>${hr}</td><td>${watts}</td></tr>`
}

export async function buildEveningReport(
  env: Env,
  today: string,
): Promise<{ subject: string; html: string }> {
  const monday = getMondayOfWeek(today)

  const tomorrow = (() => {
    const d = new Date(today + "T12:00:00Z")
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  })()

  const [activityResp, weekStravaActivities] = await Promise.all([
    fetchDailyActivity(env.OURA_API_TOKEN, today, tomorrow),
    fetchActivities(env, dateToUnix(monday), dateToUnix(today, true)),
  ])

  const todayOuraActivity = activityResp.data.find((d) => d["day"] === today)

  const todayStravaActivities = weekStravaActivities.filter((a) => {
    const startDate = String(a["start_date_local"] ?? "").slice(0, 10)
    return startDate === today
  })

  const detailedToday: StravaActivity[] = await Promise.all(
    todayStravaActivities.map((a) =>
      typeof a["id"] === "number" ? fetchActivity(env, a["id"]) : Promise.resolve(a),
    ),
  )

  const ouraSteps =
    typeof todayOuraActivity?.["steps"] === "number" ? todayOuraActivity["steps"] : null
  const ouraCals =
    typeof todayOuraActivity?.["total_calories"] === "number"
      ? todayOuraActivity["total_calories"]
      : null
  const ouraScore =
    typeof todayOuraActivity?.["score"] === "number" ? todayOuraActivity["score"] : null
  const ouraActive =
    typeof todayOuraActivity?.["active_calories"] === "number"
      ? todayOuraActivity["active_calories"]
      : null

  const weekTotalMiles = weekStravaActivities.reduce<number>((sum, a) => {
    return sum + (typeof a["distance_miles"] === "number" ? a["distance_miles"] : 0)
  }, 0)
  const weekTotalTime = weekStravaActivities.reduce<number>((sum, a) => {
    return sum + (typeof a["moving_time"] === "number" ? a["moving_time"] : 0)
  }, 0)

  const systemPrompt = `You are an enthusiastic AI training assistant helping an endurance athlete meet their goals.
Your role is to provide a thoughtful end-of-day recap that acknowledges what was accomplished today and gives context for the week.
Write in an encouraging, reflective tone — direct, specific, and energetic.
Output HTML fragment only (no doctype, no html/body tags). Use the CSS classes already in the email template:
- verdict div for the day analysis
- score-great / score-good / score-low for score coloring
Be concise but specific. Reference the actual numbers. Keep total length under 500 words.`

  const dataSummary = `
DATE: ${today}
OURA DAILY ACTIVITY:
Steps: ${ouraSteps ?? "N/A"}
Total Calories: ${ouraCals ?? "N/A"} kcal
Active Calories: ${ouraActive ?? "N/A"} kcal
Activity Score: ${ouraScore ?? "N/A"}

TODAY'S STRAVA ACTIVITIES:
${
  detailedToday.length === 0
    ? "No Strava activities today."
    : detailedToday
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
          const suffer =
            typeof a["suffer_score"] === "number" ? ` Suffer: ${a["suffer_score"]}` : ""
          return `- ${String(a["name"] ?? "Activity")} (${String(a["sport_type"] ?? a["type"] ?? "")}) | ${miles} | ${dur}${hr}${max}${watts}${np}${suffer}`
        })
        .join("\n")
}

WEEK TOTALS (${monday} – ${today}):
Activities: ${weekStravaActivities.length}
Total distance: ${weekTotalMiles.toFixed(2)} miles
Total time: ${fmtDuration(weekTotalTime)}
`

  const aiHtml = await generateReport(env.AI, systemPrompt, dataSummary)

  const ouraMetrics = [
    ouraSteps !== null
      ? `<div class="metric"><span class="metric-label">Steps</span><span class="metric-value">${ouraSteps.toLocaleString()}</span></div>`
      : "",
    ouraCals !== null
      ? `<div class="metric"><span class="metric-label">Total Calories</span><span class="metric-value">${ouraCals.toLocaleString()}</span></div>`
      : "",
    ouraActive !== null
      ? `<div class="metric"><span class="metric-label">Active Calories</span><span class="metric-value">${ouraActive.toLocaleString()}</span></div>`
      : "",
    ouraScore !== null
      ? `<div class="metric"><span class="metric-label">Activity Score</span><span class="metric-value">${ouraScore}</span></div>`
      : "",
  ]
    .filter(Boolean)
    .join("")

  const html = `
<h1>🌙 Evening Report — ${today}</h1>

${
  detailedToday.length > 0
    ? `<h2>Today's Training</h2>${detailedToday.map(buildActivityDetailHtml).join("")}`
    : "<h2>Today's Training</h2><p>No Strava activities recorded today.</p>"
}

${ouraMetrics ? `<h2>Day's Activity</h2><div>${ouraMetrics}</div>` : ""}

${
  weekStravaActivities.length > 0
    ? `<h2>Week So Far</h2>
<p><strong>${weekStravaActivities.length} activities</strong> · ${weekTotalMiles.toFixed(2)} mi · ${fmtDuration(weekTotalTime)}</p>
<table>
  <thead><tr><th>Date</th><th>Activity</th><th>Type</th><th>Distance</th><th>Duration</th><th>Avg HR</th><th>Avg Power</th></tr></thead>
  <tbody>${weekStravaActivities.map(buildWeekRow).join("\n")}</tbody>
</table>`
    : ""
}

<h2>Day Recap</h2>
${aiHtml}
`

  const totalMilesToday = detailedToday.reduce<number>((sum, a) => {
    return sum + (typeof a["distance_miles"] === "number" ? a["distance_miles"] : 0)
  }, 0)

  const subject =
    detailedToday.length > 0
      ? `Evening Report ${today} — ${detailedToday.length} workout${detailedToday.length > 1 ? "s" : ""} · ${totalMilesToday.toFixed(2)} mi`
      : `Evening Report ${today} — Rest Day`

  return { subject, html }
}
