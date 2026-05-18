import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../oura", () => ({
  fetchDailySleep: vi.fn(),
  fetchDailyReadiness: vi.fn(),
  fetchDailySpO2: vi.fn(),
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
  generateReport: vi.fn().mockResolvedValue("<p>AI verdict</p>"),
}))

import * as oura from "../../oura"
import * as strava from "../../strava"
import * as ai from "../../ai"
import { buildMorningReport } from "../../reports/morning"

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

const sleepData = [
  { day: "2025-01-13", score: 75 },
  { day: "2025-01-14", score: 80 },
  { day: "2025-01-15", score: 88 },
]

const readinessData = [
  { day: "2025-01-13", score: 72, contributors: { recovery_index: 85, sleep_balance: 70 } },
  { day: "2025-01-14", score: 79, contributors: { recovery_index: 80, sleep_balance: 75 } },
  {
    day: "2025-01-15",
    score: 85,
    contributors: { recovery_index: 95, sleep_balance: 78, hrv_balance: 71 },
  },
]

const spo2Data = [
  {
    day: "2025-01-15",
    spo2_percentage: { average: 97.5, min: 95.0 },
  },
]

const weekActivities = [
  {
    id: 123,
    name: "Morning Run",
    type: "Run",
    sport_type: "Run",
    start_date_local: "2025-01-14T07:00:00",
    distance_miles: 5.2,
    moving_time: 1800,
    average_heartrate: 145,
  },
]

const detailedActivity = {
  id: 123,
  name: "Morning Run",
  type: "Run",
  sport_type: "Run",
  start_date_local: "2025-01-14T07:00:00",
  distance_miles: 5.2,
  moving_time: 1800,
  average_heartrate: 145,
  max_heartrate: 165,
  average_watts: 250,
  weighted_average_watts: 260,
}

function setupMocks(overrides?: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sleepData?: Record<string, unknown>[]
  readinessData?: Record<string, unknown>[]
  spo2Data?: Record<string, unknown>[]
  weekActivities?: Record<string, unknown>[]
  detailedActivity?: Record<string, unknown> | null
}) {
  vi.mocked(oura.fetchDailySleep).mockResolvedValue({
    data: (overrides?.sleepData ?? sleepData) as Record<string, unknown>[],
    next_token: null,
  })
  vi.mocked(oura.fetchDailyReadiness).mockResolvedValue({
    data: (overrides?.readinessData ?? readinessData) as Record<string, unknown>[],
    next_token: null,
  })
  vi.mocked(oura.fetchDailySpO2).mockResolvedValue({
    data: (overrides?.spo2Data ?? spo2Data) as Record<string, unknown>[],
    next_token: null,
  })
  vi.mocked(strava.fetchActivities).mockResolvedValue(overrides?.weekActivities ?? weekActivities)
  if (overrides?.detailedActivity === null) {
    vi.mocked(strava.fetchActivity).mockResolvedValue({} as Record<string, unknown>)
  } else {
    vi.mocked(strava.fetchActivity).mockResolvedValue(
      (overrides?.detailedActivity ?? detailedActivity) as Record<string, unknown>,
    )
  }
}

describe("buildMorningReport", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(ai.generateReport).mockResolvedValue("<p>AI verdict</p>")
  })

  it("returns { subject, html } with today's date in subject", async () => {
    setupMocks()
    const result = await buildMorningReport(makeEnv(), TODAY)
    expect(result).toHaveProperty("subject")
    expect(result).toHaveProperty("html")
    expect(result.subject).toContain(TODAY)
  })

  it("HTML contains readiness score", async () => {
    setupMocks()
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("85")
    expect(html).toContain("Readiness Score")
  })

  it("HTML contains sleep score", async () => {
    setupMocks()
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("88")
    expect(html).toContain("Sleep Score")
  })

  it("HTML contains SpO₂ when present", async () => {
    setupMocks()
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("97.5")
    expect(html).toContain("SpO₂")
  })

  it("HTML contains yesterday's activity name", async () => {
    setupMocks()
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("Morning Run")
  })

  it("handles no activities gracefully (rest day)", async () => {
    setupMocks({ weekActivities: [] })
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("Rest day")
  })

  it("handles missing SpO₂ data", async () => {
    setupMocks({ spo2Data: [] })
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    // SpO₂ metric should not appear when data is missing
    expect(html).not.toContain("SpO₂ Avg")
  })

  it("subject includes readiness label for high score", async () => {
    setupMocks()
    const { subject } = await buildMorningReport(makeEnv(), TODAY)
    expect(subject).toContain("High")
    expect(subject).toContain("85")
  })

  it("subject includes moderate readiness label for moderate score", async () => {
    const modReadiness = readinessData.map((r) => (r.day === TODAY ? { ...r, score: 75 } : r))
    setupMocks({ readinessData: modReadiness })
    const { subject } = await buildMorningReport(makeEnv(), TODAY)
    expect(subject).toContain("Moderate")
  })

  it("subject includes low readiness label for low score", async () => {
    const lowReadiness = readinessData.map((r) => (r.day === TODAY ? { ...r, score: 60 } : r))
    setupMocks({ readinessData: lowReadiness })
    const { subject } = await buildMorningReport(makeEnv(), TODAY)
    expect(subject).toContain("Low")
  })

  it("handles missing sleep and readiness scores (null values)", async () => {
    // Data with no entry for today
    setupMocks({
      sleepData: [{ day: "2025-01-13", score: 75 }],
      readinessData: [{ day: "2025-01-13", score: 72, contributors: {} }],
    })
    const { subject, html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toBeDefined()
    // Subject should not include readiness label when score is null
    expect(subject).toBe(`Morning Report ${TODAY}`)
  })

  it("HTML contains week trend table", async () => {
    setupMocks()
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("Sleep & Readiness Trend")
    expect(html).toContain("<table>")
  })

  it("HTML contains week summary when there are activities", async () => {
    setupMocks()
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("Week So Far")
  })

  it("fetches detailed activity for yesterday's activities", async () => {
    setupMocks()
    await buildMorningReport(makeEnv(), TODAY)
    expect(strava.fetchActivity).toHaveBeenCalledWith(makeEnv(), 123)
  })

  it("skips fetchActivity when activity has no numeric id", async () => {
    const activitiesWithStringId = [
      {
        ...weekActivities[0],
        id: "string_id",
        start_date_local: "2025-01-14T07:00:00",
      },
    ]
    setupMocks({ weekActivities: activitiesWithStringId })
    await buildMorningReport(makeEnv(), TODAY)
    expect(strava.fetchActivity).not.toHaveBeenCalled()
  })

  it("includes AI-generated verdict in HTML", async () => {
    setupMocks()
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("<p>AI verdict</p>")
  })

  it("handles activities without moving_time (shows — for duration)", async () => {
    const activitiesNoTime = [
      {
        id: 200,
        name: "Unknown Activity",
        sport_type: "Run",
        start_date_local: "2025-01-14T07:00:00",
        distance_miles: 2.0,
        // no moving_time
      },
    ]
    setupMocks({ weekActivities: activitiesNoTime })
    vi.mocked(strava.fetchActivity).mockResolvedValue({
      id: 200,
      name: "Unknown Activity",
      sport_type: "Run",
      distance_miles: 2.0,
    } as Record<string, unknown>)
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("Unknown Activity")
  })

  it("handles weekly trend rows where readiness entry is missing", async () => {
    const sleepOnly = [
      { day: "2025-01-13", score: 75 },
      { day: TODAY, score: 85 },
    ]
    const readinessOnlyToday = [{ day: TODAY, score: 85, contributors: { recovery_index: 90 } }]
    setupMocks({ sleepData: sleepOnly, readinessData: readinessOnlyToday })
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    // Jan 13 sleep row should show — for readiness
    expect(html).toContain("2025-01-13")
  })

  it("handles weekly trend rows where sleep score is null", async () => {
    const sleepWithNoScore = [{ day: TODAY }] // no score
    const readinessWithScore = [{ day: TODAY, score: 80, contributors: {} }]
    setupMocks({ sleepData: sleepWithNoScore, readinessData: readinessWithScore })
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toBeDefined()
  })

  it("activity data summary uses 'type' fallback when sport_type is absent", async () => {
    const activitiesTypeOnly = [
      {
        id: 300,
        name: "Old Run",
        type: "Run",
        // no sport_type
        start_date_local: "2025-01-14T07:00:00",
        distance_miles: 3.0,
        moving_time: 1200,
        average_heartrate: 150,
        max_heartrate: 170,
        average_watts: 180,
        weighted_average_watts: 190,
      },
    ]
    setupMocks({ weekActivities: activitiesTypeOnly })
    vi.mocked(strava.fetchActivity).mockResolvedValue({
      ...activitiesTypeOnly[0],
    } as Record<string, unknown>)
    const { html } = await buildMorningReport(makeEnv(), TODAY)
    expect(html).toContain("Old Run")
  })
})
