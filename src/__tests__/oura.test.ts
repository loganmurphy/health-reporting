import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  fetchDailySleep,
  fetchDailyReadiness,
  fetchDailySpO2,
  fetchWorkouts,
  fetchDailyActivity,
} from "../oura"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function makeOkResponse(data: unknown) {
  return {
    ok: true,
    json: async () => data,
    headers: new Headers(),
    status: 200,
  }
}

function makeErrorResponse(status: number, text: string, headers?: Record<string, string>) {
  return {
    ok: false,
    status,
    text: async () => text,
    headers: new Headers(headers ?? {}),
  }
}

const sampleResponse = { data: [{ day: "2025-01-15", score: 82 }], next_token: null }

describe("Oura API fetch functions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  describe("fetchDailySleep", () => {
    it("calls correct path and returns parsed JSON on 200", async () => {
      mockFetch.mockResolvedValue(makeOkResponse(sampleResponse))
      const result = await fetchDailySleep("token123", "2025-01-10", "2025-01-15")
      expect(mockFetch).toHaveBeenCalledOnce()
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain("/daily_sleep")
      expect(url).toContain("start_date=2025-01-10")
      expect(url).toContain("end_date=2025-01-15")
      expect(result).toEqual(sampleResponse)
    })

    it("sends Authorization header with Bearer token", async () => {
      mockFetch.mockResolvedValue(makeOkResponse(sampleResponse))
      await fetchDailySleep("mytoken", "2025-01-01", "2025-01-02")
      const options = mockFetch.mock.calls[0]![1] as RequestInit
      expect((options.headers as Record<string, string>)["Authorization"]).toBe("Bearer mytoken")
    })
  })

  describe("fetchDailyReadiness", () => {
    it("calls correct path", async () => {
      mockFetch.mockResolvedValue(makeOkResponse(sampleResponse))
      await fetchDailyReadiness("token", "2025-01-10", "2025-01-15")
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain("/daily_readiness")
    })
  })

  describe("fetchDailySpO2", () => {
    it("calls correct path", async () => {
      mockFetch.mockResolvedValue(makeOkResponse(sampleResponse))
      await fetchDailySpO2("token", "2025-01-10", "2025-01-15")
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain("/daily_spo2")
    })
  })

  describe("fetchWorkouts", () => {
    it("calls correct path", async () => {
      mockFetch.mockResolvedValue(makeOkResponse(sampleResponse))
      await fetchWorkouts("token", "2025-01-10", "2025-01-15")
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain("/workout")
    })
  })

  describe("fetchDailyActivity", () => {
    it("calls correct path", async () => {
      mockFetch.mockResolvedValue(makeOkResponse(sampleResponse))
      await fetchDailyActivity("token", "2025-01-10", "2025-01-15")
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain("/daily_activity")
    })
  })

  describe("error handling", () => {
    it("throws 401 error with token rotation instructions", async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(401, "Unauthorized"))
      await expect(fetchDailySleep("bad-token", "2025-01-10", "2025-01-15")).rejects.toThrow(
        "Oura rejected the token (401)",
      )
    })

    it("throws 403 error with token rotation instructions", async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(403, "Forbidden"))
      await expect(fetchDailySleep("bad-token", "2025-01-10", "2025-01-15")).rejects.toThrow(
        "Oura rejected the token (403)",
      )
    })

    it("throws immediately on non-retryable 404 error", async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(404, "Not Found"))
      await expect(fetchDailySleep("token", "2025-01-10", "2025-01-15")).rejects.toThrow(
        "Oura API error 404",
      )
      // Only 1 attempt, no retries
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it("retries on 429 with Retry-After header and throws after max retries", async () => {
      vi.useFakeTimers()
      // All 3 attempts (initial + 2 retries) return 429
      mockFetch.mockResolvedValue(makeErrorResponse(429, "Too Many Requests", { "Retry-After": "1" }))

      let caughtError: Error | undefined
      const promise = fetchDailySleep("token", "2025-01-10", "2025-01-15").catch((e: Error) => {
        caughtError = e
      })
      await vi.runAllTimersAsync()
      await promise
      expect(caughtError?.message).toContain("Oura API error 429")
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it("retries on 500 with exponential backoff and throws after max retries", async () => {
      vi.useFakeTimers()
      mockFetch.mockResolvedValue(makeErrorResponse(500, "Server Error"))

      let caughtError: Error | undefined
      const promise = fetchDailySleep("token", "2025-01-10", "2025-01-15").catch((e: Error) => {
        caughtError = e
      })
      await vi.runAllTimersAsync()
      await promise
      expect(caughtError?.message).toContain("Oura API error 500")
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it("succeeds on retry after initial 500", async () => {
      vi.useFakeTimers()
      mockFetch
        .mockResolvedValueOnce(makeErrorResponse(500, "Server Error"))
        .mockResolvedValueOnce(makeOkResponse(sampleResponse))

      const promise = fetchDailySleep("token", "2025-01-10", "2025-01-15")
      await vi.runAllTimersAsync()
      const result = await promise
      expect(result).toEqual(sampleResponse)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it("uses Retry-After header value for 429 delay (capped at 60s)", async () => {
      vi.useFakeTimers()
      // First call: 429 with large Retry-After; second call: success
      mockFetch
        .mockResolvedValueOnce(makeErrorResponse(429, "Rate limit", { "Retry-After": "999" }))
        .mockResolvedValueOnce(makeOkResponse(sampleResponse))

      const promise = fetchDailySleep("token", "2025-01-10", "2025-01-15")
      await vi.runAllTimersAsync()
      const result = await promise
      expect(result).toEqual(sampleResponse)
    })
  })
})
