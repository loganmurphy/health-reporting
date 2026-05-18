import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchActivities, fetchActivity, dateToUnix } from "../strava"
import type { StravaEnv } from "../strava"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function makeMockKv(accessToken?: string, refreshToken?: string) {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === "strava:access_token") return Promise.resolve(accessToken ?? null)
      if (key === "strava:refresh_token") return Promise.resolve(refreshToken ?? null)
      return Promise.resolve(null)
    }),
    put: vi.fn().mockResolvedValue(undefined),
  }
}

function makeEnv(overrides?: Partial<StravaEnv>): StravaEnv {
  return {
    OAUTH_KV: makeMockKv() as unknown as KVNamespace,
    STRAVA_CLIENT_ID: "client_id",
    STRAVA_CLIENT_SECRET: "client_secret",
    STRAVA_REFRESH_TOKEN: "env_refresh_token",
    ...overrides,
  }
}

function makeFreshCachedToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  return JSON.stringify({ token: "cached_access_token", expires_at: expiresAt })
}

function makeExpiredCachedToken() {
  const expiresAt = Math.floor(Date.now() / 1000) - 100
  return JSON.stringify({ token: "old_access_token", expires_at: expiresAt })
}

function makeRefreshResponse() {
  return {
    ok: true,
    json: async () => ({
      access_token: "new_access_token",
      refresh_token: "new_refresh_token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  }
}

function makeActivitiesResponse(activities = [{ id: 1, name: "Morning Run", sport_type: "Run", distance: 8046.7, moving_time: 1800, map: { id: "map1" } }]) {
  return {
    ok: true,
    json: async () => activities,
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

describe("fetchActivities", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("uses cached token when fresh, skips refresh", async () => {
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce(makeActivitiesResponse())

    await fetchActivities(env, 1700000000, 1700086400)

    // KV.get called for access token, not for refresh token
    expect(kv.get).toHaveBeenCalledWith("strava:access_token")
    expect(kv.put).not.toHaveBeenCalled()

    // Fetch called with cached token
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((options.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer cached_access_token",
    )
  })

  it("refreshes token when expired, writes new tokens to KV", async () => {
    const kv = makeMockKv(makeExpiredCachedToken(), "stored_refresh_token")
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    // First fetch: refresh call; second fetch: activities
    mockFetch
      .mockResolvedValueOnce(makeRefreshResponse())
      .mockResolvedValueOnce(makeActivitiesResponse())

    await fetchActivities(env, 1700000000, 1700086400)

    expect(kv.put).toHaveBeenCalledWith(
      "strava:access_token",
      expect.stringContaining("new_access_token"),
      expect.any(Object),
    )
    expect(kv.put).toHaveBeenCalledWith("strava:refresh_token", "new_refresh_token")
  })

  it("uses STRAVA_REFRESH_TOKEN env fallback when KV has no refresh token", async () => {
    const kv = makeMockKv(makeExpiredCachedToken(), null)
    const env = makeEnv({
      OAUTH_KV: kv as unknown as KVNamespace,
      STRAVA_REFRESH_TOKEN: "env_fallback_token",
    })

    mockFetch
      .mockResolvedValueOnce(makeRefreshResponse())
      .mockResolvedValueOnce(makeActivitiesResponse())

    await fetchActivities(env, 1700000000, 1700086400)

    // Should have called refresh endpoint with env fallback
    const refreshCall = mockFetch.mock.calls[0]
    const body = JSON.parse(refreshCall[1].body as string)
    expect(body.refresh_token).toBe("env_fallback_token")
  })

  it("throws when no refresh token at all", async () => {
    const kv = makeMockKv(makeExpiredCachedToken(), null)
    const env = makeEnv({
      OAUTH_KV: kv as unknown as KVNamespace,
      STRAVA_REFRESH_TOKEN: "",
    })

    await expect(fetchActivities(env, 1700000000, 1700086400)).rejects.toThrow(
      "Strava refresh token not found",
    )
  })

  it("strips map field from activities", async () => {
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce(
      makeActivitiesResponse([
        {
          id: 1,
          name: "Run",
          sport_type: "Run",
          distance: 8046.7,
          moving_time: 1800,
          map: { id: "map1" },
        },
      ]),
    )

    const result = await fetchActivities(env, 1700000000, 1700086400)
    expect(result[0]).not.toHaveProperty("map")
  })

  it("converts distance from meters to miles", async () => {
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    // 1609.34 meters = 1 mile
    mockFetch.mockResolvedValueOnce(
      makeActivitiesResponse([
        { id: 1, name: "Run", sport_type: "Run", distance: 1609.34, moving_time: 300, map: null },
      ]),
    )

    const result = await fetchActivities(env, 1700000000, 1700086400)
    expect(result[0]["distance_miles"]).toBe(1)
    expect(result[0]).not.toHaveProperty("distance")
  })

  it("retries on 429, then succeeds", async () => {
    vi.useFakeTimers()
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(429, "Rate limited", { "Retry-After": "1" }))
      .mockResolvedValueOnce(makeActivitiesResponse())

    const promise = fetchActivities(env, 1700000000, 1700086400)
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toHaveLength(1)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("retries on 500, then succeeds", async () => {
    vi.useFakeTimers()
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500, "Server Error"))
      .mockResolvedValueOnce(makeActivitiesResponse())

    const promise = fetchActivities(env, 1700000000, 1700086400)
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toHaveLength(1)
  })

  it("throws after max retries exhausted on 500", async () => {
    vi.useFakeTimers()
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValue(makeErrorResponse(500, "Server Error"))

    let caughtError: Error | undefined
    const promise = fetchActivities(env, 1700000000, 1700086400).catch((e: Error) => {
      caughtError = e
    })
    await vi.runAllTimersAsync()
    await promise
    expect(caughtError?.message).toContain("Strava API error 500")
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it("throws on 401 without retrying", async () => {
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce(makeErrorResponse(401, "Unauthorized"))

    await expect(fetchActivities(env, 1700000000, 1700086400)).rejects.toThrow("Strava API 401")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe("fetchActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("fetches single activity by ID, strips map, converts distance", async () => {
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 42,
        name: "Long Ride",
        sport_type: "Ride",
        distance: 80467,
        moving_time: 7200,
        map: { polyline: "abc123" },
        average_watts: 200,
      }),
    })

    const result = await fetchActivity(env, 42)
    expect(result["name"]).toBe("Long Ride")
    expect(result).not.toHaveProperty("map")
    expect(result).not.toHaveProperty("distance")
    expect(result["distance_miles"]).toBe(50)
  })

  it("calls correct API path with activity ID", async () => {
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 99, name: "Run", distance: 0 }),
    })

    await fetchActivity(env, 99)
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain("/activities/99")
  })
})

describe("refreshAccessToken error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("throws with re-auth message on 400", async () => {
    const kv = makeMockKv(makeExpiredCachedToken(), "stored_refresh")
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce(makeErrorResponse(400, "Bad Request"))

    await expect(fetchActivities(env, 0, 0)).rejects.toThrow(
      "Strava refresh token rejected (400)",
    )
  })

  it("throws with re-auth message on 401", async () => {
    const kv = makeMockKv(makeExpiredCachedToken(), "stored_refresh")
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce(makeErrorResponse(401, "Unauthorized"))

    await expect(fetchActivities(env, 0, 0)).rejects.toThrow(
      "Strava refresh token rejected (401)",
    )
  })

  it("throws generic error on other refresh failures", async () => {
    const kv = makeMockKv(makeExpiredCachedToken(), "stored_refresh")
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce(makeErrorResponse(500, "Server Error"))

    await expect(fetchActivities(env, 0, 0)).rejects.toThrow("Strava token refresh failed (500)")
  })
})

describe("convertDistances edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("leaves activity unchanged when no distance field", async () => {
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: "Run", sport_type: "Run", moving_time: 300 }],
    })

    const result = await fetchActivities(env, 1700000000, 1700086400)
    expect(result[0]).not.toHaveProperty("distance")
    expect(result[0]).not.toHaveProperty("distance_miles")
  })

  it("handles activity with zero distance", async () => {
    const kv = makeMockKv(makeFreshCachedToken())
    const env = makeEnv({ OAUTH_KV: kv as unknown as KVNamespace })

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: "Run", distance: 0, moving_time: 300 }],
    })

    const result = await fetchActivities(env, 1700000000, 1700086400)
    expect(result[0]["distance_miles"]).toBe(0)
  })
})

describe("dateToUnix", () => {
  it("returns correct unix timestamp for start of day", () => {
    // 2025-01-15T00:00:00Z
    const result = dateToUnix("2025-01-15")
    expect(result).toBe(1736899200)
  })

  it("adds one day when endOfDay=true", () => {
    const start = dateToUnix("2025-01-15")
    const end = dateToUnix("2025-01-15", true)
    expect(end).toBe(start + 86400)
  })

  it("handles month boundary correctly", () => {
    const result = dateToUnix("2025-02-01")
    const endOfJan = dateToUnix("2025-01-31", true)
    expect(result).toBe(endOfJan)
  })
})
