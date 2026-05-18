import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../oura", () => ({
  fetchDailyActivity: vi.fn(),
}))

vi.mock("../../strava", () => ({
  fetchActivities: vi.fn(),
  fetchActivity: vi.fn(),
  dateToUnix: vi.fn().mockImplementation((date: string, endOfDay?: boolean) => {
    const d = new Date(date + "T00:00:00Z")
    if (endOfDay) d.setUTCDate(d.getUTCDate() + 1)
    return Math.floor(d.getTime() / 1000)
  }),
}))

vi.mock("../../ai", () => ({
  generateReport: vi.fn().mockResolvedValue("<p>AI recap</p>"),
}))

import * as oura from "../../oura"
import * as strava from "../../strava"
import * as ai from "../../ai"
import { buildEveningReport } from "../../reports/evening"

const TODAY = "2025-01-15"

function makeEnv() {
  return {
    AI: {} as Ai,
    OAUTH_KV: {} as KVNamespace,
    OURA_API_TOKEN: "oura_token",
    STRAVA_CLIENT_ID: "strava_id",
    STRAVA_CLIENT_SECRET: "strava_secret",
    STRAVA_REFRESH_TOKEN: "strava_refresh",
    RESEND_API_KEY: "resend_key",
    REPORT_RECIPIENT: "user@example.com",
    REPORT_FROM: "reports@example.com",
  }
}

const ouraActivityData = [
  {
    day: TODAY,
    steps: 9500,
    total_calories: 2200,
    active_calories: 650,
    score: 78,
  },
]

const todayActivities = [
  {
    id: 456,
    name: "Evening Ride",
    type: "Ride",
    sport_type: "Ride",
    start_date_local: `${TODAY}T17:00:00`,
    distance_miles: 25.5,
    moving_time: 4500,
    average_heartrate: 152,
  },
]

const detailedActivity = {
  id: 456,
  name: "Evening Ride",
  type: "Ride",
  sport_type: "Ride",
  start_date_local: `${TODAY}T17:00:00`,
  distance_miles: 25.5,
  moving_time: 4500,
  average_heartrate: 152,
  max_heartrate: 172,
  total_elevation_gain: 500,
  average_watts: 220,
  weighted_average_watts: 235,
  max_watts: 450,
  calories: 850,
  kudos_count: 5,
  suffer_score: 78,
  description: "Great ride!",
}

function setupMocks(overrides?: {
  ouraData?: typeof ouraActivityData
  weekActivities?: typeof todayActivities
  detailedActivity?: typeof detailedActivity | Record<string, unknown>
}) {
  vi.mocked(oura.fetchDailyActivity).mockResolvedValue({
    data: (overrides?.ouraData ?? ouraActivityData) as Record<string, unknown>[],
    next_token: null,
  })
  vi.mocked(strava.fetchActivities).mockResolvedValue(overrides?.weekActivities ?? todayActivities)
  vi.mocked(strava.fetchActivity).mockResolvedValue(
    (overrides?.detailedActivity ?? detailedActivity) as Record<string, unknown>,
  )
}

describe("buildEveningReport", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(ai.generateReport).mockResolvedValue("<p>AI recap</p>")
  })

  it("returns { subject, html } with today's date in subject", async () => {
    setupMocks()
    const result = await buildEveningReport(makeEnv(), TODAY)
    expect(result).toHaveProperty("subject")
    expect(result).toHaveProperty("html")
    expect(result.subject).toContain(TODAY)
  })

  it("HTML contains today's activity name", async () => {
    setupMocks()
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("Evening Ride")
  })

  it("HTML contains Oura daily activity steps", async () => {
    setupMocks()
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("9,500")
    expect(html).toContain("Steps")
  })

  it("HTML contains Oura total calories", async () => {
    setupMocks()
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("2,200")
    expect(html).toContain("Total Calories")
  })

  it("HTML contains Oura activity score", async () => {
    setupMocks()
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("78")
    expect(html).toContain("Activity Score")
  })

  it("handles no activities (rest day message)", async () => {
    setupMocks({ weekActivities: [] })
    const { html, subject } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("No Strava activities recorded today")
    expect(subject).toContain("Rest Day")
  })

  it("subject contains activity count and miles when activities exist", async () => {
    setupMocks()
    const { subject } = await buildEveningReport(makeEnv(), TODAY)
    expect(subject).toContain("1 workout")
    expect(subject).toContain("25.50 mi")
  })

  it("subject uses plural 'workouts' for multiple activities", async () => {
    const twoActivities = [
      { ...todayActivities[0], id: 1 },
      { ...todayActivities[0], id: 2, name: "Second Run", distance_miles: 3.1 },
    ]
    vi.mocked(oura.fetchDailyActivity).mockResolvedValue({
      data: ouraActivityData as Record<string, unknown>[],
      next_token: null,
    })
    vi.mocked(strava.fetchActivities).mockResolvedValue(twoActivities)
    vi.mocked(strava.fetchActivity).mockResolvedValue(detailedActivity as Record<string, unknown>)

    const { subject } = await buildEveningReport(makeEnv(), TODAY)
    expect(subject).toContain("2 workouts")
  })

  it("includes AI-generated recap in HTML", async () => {
    setupMocks()
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("<p>AI recap</p>")
  })

  it("HTML contains week so far section with activities", async () => {
    setupMocks()
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("Week So Far")
  })

  it("HTML does not include week so far section with no activities", async () => {
    setupMocks({ weekActivities: [] })
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).not.toContain("Week So Far")
  })

  it("HTML includes activity description when present", async () => {
    setupMocks()
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("Great ride!")
  })

  it("handles activity without optional fields gracefully", async () => {
    const minimalActivity = {
      id: 789,
      name: "Simple Run",
      sport_type: "Run",
      start_date_local: `${TODAY}T08:00:00`,
      distance_miles: 3.0,
      moving_time: 1200,
    }
    vi.mocked(oura.fetchDailyActivity).mockResolvedValue({
      data: ouraActivityData as Record<string, unknown>[],
      next_token: null,
    })
    vi.mocked(strava.fetchActivities).mockResolvedValue([minimalActivity])
    vi.mocked(strava.fetchActivity).mockResolvedValue(minimalActivity as Record<string, unknown>)

    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("Simple Run")
    // Optional heartrate field not shown in the detail ul (shows — in week table header but not as bullet)
    expect(html).toContain("3.00 mi")
  })

  it("handles missing Oura activity data", async () => {
    setupMocks({ ouraData: [] })
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    // Oura metrics should be empty but HTML should still render
    expect(html).toContain("Day Recap")
  })

  it("fetches detailed activity for today's Strava activities", async () => {
    setupMocks()
    await buildEveningReport(makeEnv(), TODAY)
    expect(strava.fetchActivity).toHaveBeenCalledWith(makeEnv(), 456)
  })

  it("skips fetchActivity when activity has no numeric id", async () => {
    const activityNoId = [{ ...todayActivities[0], id: "string_id" }]
    vi.mocked(oura.fetchDailyActivity).mockResolvedValue({
      data: ouraActivityData as Record<string, unknown>[],
      next_token: null,
    })
    vi.mocked(strava.fetchActivities).mockResolvedValue(activityNoId)

    await buildEveningReport(makeEnv(), TODAY)
    expect(strava.fetchActivity).not.toHaveBeenCalled()
  })
})

describe("buildEveningReport additional coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(ai.generateReport).mockResolvedValue("<p>AI recap</p>")
  })

  it("handles activity with suffer_score in data summary", async () => {
    const activityWithSuffer = {
      id: 500,
      name: "Hard Run",
      sport_type: "Run",
      start_date_local: `${TODAY}T08:00:00`,
      distance_miles: 5.0,
      moving_time: 1800,
      average_heartrate: 165,
      max_heartrate: 180,
      average_watts: 250,
      weighted_average_watts: 260,
      suffer_score: 95,
    }
    vi.mocked(oura.fetchDailyActivity).mockResolvedValue({
      data: ouraActivityData as Record<string, unknown>[],
      next_token: null,
    })
    vi.mocked(strava.fetchActivities).mockResolvedValue([activityWithSuffer])
    vi.mocked(strava.fetchActivity).mockResolvedValue(activityWithSuffer as Record<string, unknown>)

    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("Hard Run")
  })

  it("handles activity without moving_time in data summary", async () => {
    const activityNoTime = {
      id: 600,
      name: "No Time Run",
      sport_type: "Run",
      start_date_local: `${TODAY}T08:00:00`,
      distance_miles: 3.0,
      // no moving_time
    }
    vi.mocked(oura.fetchDailyActivity).mockResolvedValue({
      data: ouraActivityData as Record<string, unknown>[],
      next_token: null,
    })
    vi.mocked(strava.fetchActivities).mockResolvedValue([activityNoTime])
    vi.mocked(strava.fetchActivity).mockResolvedValue(activityNoTime as Record<string, unknown>)

    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("No Time Run")
  })

  it("handles activity with type fallback when sport_type is absent", async () => {
    const activityTypeOnly = {
      id: 700,
      name: "Legacy Activity",
      type: "Ride",
      // no sport_type
      start_date_local: `${TODAY}T10:00:00`,
      distance_miles: 20.0,
      moving_time: 3600,
    }
    vi.mocked(oura.fetchDailyActivity).mockResolvedValue({
      data: ouraActivityData as Record<string, unknown>[],
      next_token: null,
    })
    vi.mocked(strava.fetchActivities).mockResolvedValue([activityTypeOnly])
    vi.mocked(strava.fetchActivity).mockResolvedValue(activityTypeOnly as Record<string, unknown>)

    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("Legacy Activity")
  })
})

describe("fmtDuration (via report HTML)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(ai.generateReport).mockResolvedValue("<p>recap</p>")
  })

  it("formats hours+minutes correctly", async () => {
    // 4500 seconds = 1h 15m
    setupMocks()
    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("1h 15m")
  })

  it("formats minutes-only correctly (under 1 hour)", async () => {
    const shortActivity = [
      {
        id: 100,
        name: "Short Run",
        sport_type: "Run",
        start_date_local: `${TODAY}T08:00:00`,
        distance_miles: 1.5,
        moving_time: 900, // 15 minutes
      },
    ]
    vi.mocked(oura.fetchDailyActivity).mockResolvedValue({
      data: ouraActivityData as Record<string, unknown>[],
      next_token: null,
    })
    vi.mocked(strava.fetchActivities).mockResolvedValue(shortActivity)
    vi.mocked(strava.fetchActivity).mockResolvedValue({
      ...shortActivity[0],
      moving_time: 900,
    } as Record<string, unknown>)

    const { html } = await buildEveningReport(makeEnv(), TODAY)
    expect(html).toContain("15m")
    expect(html).not.toMatch(/\d+h \d+m.*15m/)
  })
})
