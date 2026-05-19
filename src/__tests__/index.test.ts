import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../reports/morning", () => ({
  buildMorningReport: vi
    .fn()
    .mockResolvedValue({ subject: "Morning Subject", html: "<p>morning</p>" }),
}))

vi.mock("../reports/evening", () => ({
  buildEveningReport: vi
    .fn()
    .mockResolvedValue({ subject: "Evening Subject", html: "<p>evening</p>" }),
}))

vi.mock("../email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}))

import * as morning from "../reports/morning"
import * as evening from "../reports/evening"
import * as email from "../email"
import worker from "../index"

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
    MORNING_CRON: "30 15 * * *",
    EVENING_CRON: "0 2 * * *",
    UTC_OFFSET: "-6",
  }
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
}

describe("fetch handler", () => {
  it("returns 404 for any request", async () => {
    const req = new Request("http://localhost/anything")
    const res = await worker.fetch(req, makeEnv(), makeCtx())
    expect(res.status).toBe(404)
  })

  it("returns 404 for root path", async () => {
    const req = new Request("http://localhost/")
    const res = await worker.fetch(req, makeEnv(), makeCtx())
    expect(res.status).toBe(404)
  })
})

describe("scheduled handler", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls buildMorningReport and sendEmail when cron is '30 15 * * *'", async () => {
    const event = { cron: "30 15 * * *", scheduledTime: Date.now() } as ScheduledEvent
    await worker.scheduled(event, makeEnv(), makeCtx())

    expect(morning.buildMorningReport).toHaveBeenCalledOnce()
    expect(evening.buildEveningReport).not.toHaveBeenCalled()
    expect(email.sendEmail).toHaveBeenCalledWith(
      { apiKey: "resend_key", from: "reports@example.com", to: "user@example.com" },
      "Morning Subject",
      "<p>morning</p>",
    )
  })

  it("calls buildEveningReport and sendEmail when cron is '0 2 * * *'", async () => {
    const event = { cron: "0 2 * * *", scheduledTime: Date.now() } as ScheduledEvent
    await worker.scheduled(event, makeEnv(), makeCtx())

    expect(evening.buildEveningReport).toHaveBeenCalledOnce()
    expect(morning.buildMorningReport).not.toHaveBeenCalled()
    expect(email.sendEmail).toHaveBeenCalledWith(
      { apiKey: "resend_key", from: "reports@example.com", to: "user@example.com" },
      "Evening Subject",
      "<p>evening</p>",
    )
  })

  it("passes local date (adjusted for UTC_OFFSET) to morning report", async () => {
    const scheduledTime = Date.now()
    const event = { cron: "30 15 * * *", scheduledTime } as ScheduledEvent
    await worker.scheduled(event, makeEnv(), makeCtx())

    const expected = new Date(scheduledTime + -6 * 3600 * 1000).toISOString().slice(0, 10)
    const [, calledToday] = (morning.buildMorningReport as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, string]
    expect(calledToday).toBe(expected)
  })

  it("passes local date (adjusted for UTC_OFFSET) to evening report", async () => {
    const scheduledTime = Date.now()
    const event = { cron: "0 2 * * *", scheduledTime } as ScheduledEvent
    await worker.scheduled(event, makeEnv(), makeCtx())

    const expected = new Date(scheduledTime + -6 * 3600 * 1000).toISOString().slice(0, 10)
    const [, calledToday] = (evening.buildEveningReport as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, string]
    expect(calledToday).toBe(expected)
  })

  it("defaults UTC_OFFSET to 0 when not set", async () => {
    const scheduledTime = Date.now()
    const event = { cron: "30 15 * * *", scheduledTime } as ScheduledEvent
    const env = { ...makeEnv(), UTC_OFFSET: undefined as unknown as string }
    await worker.scheduled(event, env, makeCtx())

    const expected = new Date(scheduledTime).toISOString().slice(0, 10)
    const [, calledToday] = (morning.buildMorningReport as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, string]
    expect(calledToday).toBe(expected)
  })
})
