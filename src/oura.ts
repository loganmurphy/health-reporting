const OURA_BASE = "https://api.ouraring.com/v2/usercollection"
const MAX_RETRIES = 2

type OuraResponse = { data: Record<string, unknown>[]; next_token: string | null }

function buildParams(startDate: string, endDate: string): URLSearchParams {
  return new URLSearchParams({ start_date: startDate, end_date: endDate })
}

async function ouraget(
  token: string,
  path: string,
  params: URLSearchParams,
): Promise<OuraResponse> {
  const url = `${OURA_BASE}${path}?${params.toString()}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

    if (res.ok) return res.json() as Promise<OuraResponse>

    const text = await res.text()

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Oura rejected the token (${res.status}). Your Personal Access Token has likely expired — ` +
          `generate a new one at https://cloud.ouraring.com/personal-access-tokens and rotate it with: ` +
          `npx wrangler secret put OURA_API_TOKEN`,
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

    throw new Error(`Oura API error ${res.status}: ${text}`)
  }

  // v8 ignore next -- loop always returns or throws before this
  throw new Error("Oura API request failed after retries")
}

export async function fetchDailySleep(
  token: string,
  startDate: string,
  endDate: string,
): Promise<OuraResponse> {
  return ouraget(token, "/daily_sleep", buildParams(startDate, endDate))
}

export async function fetchDailyReadiness(
  token: string,
  startDate: string,
  endDate: string,
): Promise<OuraResponse> {
  return ouraget(token, "/daily_readiness", buildParams(startDate, endDate))
}

export async function fetchDailySpO2(
  token: string,
  startDate: string,
  endDate: string,
): Promise<OuraResponse> {
  return ouraget(token, "/daily_spo2", buildParams(startDate, endDate))
}

export async function fetchWorkouts(
  token: string,
  startDate: string,
  endDate: string,
): Promise<OuraResponse> {
  return ouraget(token, "/workout", buildParams(startDate, endDate))
}

export async function fetchDailyActivity(
  token: string,
  startDate: string,
  endDate: string,
): Promise<OuraResponse> {
  return ouraget(token, "/daily_activity", buildParams(startDate, endDate))
}
