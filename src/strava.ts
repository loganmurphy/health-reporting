// Tokens live in OAUTH_KV rather than Worker secrets so the Worker can rotate them
// at runtime — secrets are read-only after deployment.

const STRAVA_BASE = "https://www.strava.com/api/v3"
const ACCESS_TOKEN_KEY = "strava:access_token"
const REFRESH_TOKEN_KEY = "strava:refresh_token"
const REFRESH_URL = "https://www.strava.com/oauth/token"
const EXPIRY_BUFFER_SECS = 60
const MAX_RETRIES = 2
const METERS_PER_MILE = 1609.34

interface CachedAccessToken {
  token: string
  expires_at: number
}

interface RefreshResponse {
  access_token: string
  refresh_token: string
  expires_at: number
}

export interface StravaEnv {
  OAUTH_KV: KVNamespace
  STRAVA_CLIENT_ID: string
  STRAVA_CLIENT_SECRET: string
  STRAVA_REFRESH_TOKEN: string
}

export type StravaActivity = Record<string, unknown>

async function getAccessToken(env: StravaEnv): Promise<string> {
  const cached = await env.OAUTH_KV.get(ACCESS_TOKEN_KEY)
  if (cached) {
    const { token, expires_at } = JSON.parse(cached) as CachedAccessToken
    if (Math.floor(Date.now() / 1000) < expires_at - EXPIRY_BUFFER_SECS) {
      return token
    }
  }

  const refreshToken =
    (await env.OAUTH_KV.get(REFRESH_TOKEN_KEY)) || env.STRAVA_REFRESH_TOKEN || null
  if (!refreshToken) {
    throw new Error(
      "Strava refresh token not found. Run `pnpm bootstrap` to authorize Strava.",
    )
  }

  return refreshAccessToken(env, refreshToken)
}

async function refreshAccessToken(env: StravaEnv, refreshToken: string): Promise<string> {
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 400 || res.status === 401) {
      throw new Error(
        `Strava refresh token rejected (${res.status}). Re-authorize by running \`pnpm bootstrap\`.`,
      )
    }
    throw new Error(`Strava token refresh failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as RefreshResponse
  const ttlSecs = data.expires_at - Math.floor(Date.now() / 1000) + EXPIRY_BUFFER_SECS
  await Promise.all([
    env.OAUTH_KV.put(
      ACCESS_TOKEN_KEY,
      JSON.stringify({ token: data.access_token, expires_at: data.expires_at }),
      { expirationTtl: Math.max(ttlSecs, 60) },
    ),
    env.OAUTH_KV.put(REFRESH_TOKEN_KEY, data.refresh_token),
  ])

  return data.access_token
}

function stripActivityNoise(activity: StravaActivity): StravaActivity {
  const result = { ...activity }
  delete result["map"]
  return result
}

function metersToMiles(meters: unknown): number | undefined {
  if (typeof meters !== "number") return undefined
  return Math.round((meters / METERS_PER_MILE) * 100) / 100
}

function convertDistances(activity: StravaActivity): StravaActivity {
  const result = { ...activity }
  if (typeof result["distance"] === "number") {
    result["distance_miles"] = metersToMiles(result["distance"])
    delete result["distance"]
  }
  return result
}

async function stravaFetch(
  env: StravaEnv,
  path: string,
  params?: URLSearchParams,
): Promise<unknown> {
  const qs = params?.toString()
  const url = `${STRAVA_BASE}${path}${qs ? "?" + qs : ""}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getAccessToken(env)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

    if (res.ok) return res.json()

    const text = await res.text()

    if (res.status === 401) {
      throw new Error(
        `Strava API 401: ${text}\n\n` +
          "Token is expired or revoked. Re-authorize by running `pnpm bootstrap`.",
      )
    }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const delayMs =
        res.status === 429
          ? Math.min(parseInt(res.headers.get("Retry-After") ?? "60", 10) * 1_000, 60_000)
          : 1_000 * 2 ** attempt
      await new Promise<void>((r) => setTimeout(r, delayMs))
      continue
    }

    throw new Error(`Strava API error ${res.status}: ${text}`)
  }

  // v8 ignore next -- loop always returns or throws before this
  throw new Error("Strava API request failed after retries")
}

export async function fetchActivities(
  env: StravaEnv,
  afterTs: number,
  beforeTs: number,
): Promise<StravaActivity[]> {
  const params = new URLSearchParams({
    after: String(afterTs),
    before: String(beforeTs),
    per_page: "50",
  })
  const data = (await stravaFetch(env, "/athlete/activities", params)) as StravaActivity[]
  return data.map(stripActivityNoise).map(convertDistances)
}

export async function fetchActivity(
  env: StravaEnv,
  activityId: number | string,
): Promise<StravaActivity> {
  const data = (await stravaFetch(env, `/activities/${activityId}`)) as StravaActivity
  return convertDistances(stripActivityNoise(data))
}

export function dateToUnix(dateStr: string, endOfDay = false): number {
  const d = new Date(dateStr + "T00:00:00Z")
  if (endOfDay) d.setUTCDate(d.getUTCDate() + 1)
  return Math.floor(d.getTime() / 1000)
}
