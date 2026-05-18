import { describe, it, expect, vi, beforeEach } from "vitest"
import { sendEmail } from "../email"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

const config = {
  apiKey: "re_test_key_123",
  from: "reports@example.com",
  to: "user@example.com",
}

describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("POSTs to correct URL with correct headers and body", async () => {
    mockFetch.mockResolvedValue({ ok: true })
    await sendEmail(config, "Test Subject", "<p>Hello</p>")

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.resend.com/emails")
    expect(options.method).toBe("POST")
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json")

    const body = JSON.parse(options.body as string)
    expect(body.from).toBe("reports@example.com")
    expect(body.to).toEqual(["user@example.com"])
    expect(body.subject).toBe("Test Subject")
  })

  it("wraps html fragment in full template with DOCTYPE", async () => {
    mockFetch.mockResolvedValue({ ok: true })
    await sendEmail(config, "Subject", "<p>Fragment</p>")

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(body.html).toContain("<!DOCTYPE html>")
  })

  it("wraps html fragment in full template with card div", async () => {
    mockFetch.mockResolvedValue({ ok: true })
    await sendEmail(config, "Subject", "<p>Fragment</p>")

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(body.html).toContain('class="card"')
    expect(body.html).toContain("<p>Fragment</p>")
  })

  it("wraps html fragment in full template with footer", async () => {
    mockFetch.mockResolvedValue({ ok: true })
    await sendEmail(config, "Subject", "<p>Fragment</p>")

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(body.html).toContain("health-reporting")
    expect(body.html).toContain("footer")
  })

  it("sets correct Authorization header with API key", async () => {
    mockFetch.mockResolvedValue({ ok: true })
    await sendEmail(config, "Subject", "<p>Fragment</p>")

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((options.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer re_test_key_123",
    )
  })

  it("throws on non-ok Resend response with status and body in message", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"message":"Invalid email"}',
    })

    await expect(sendEmail(config, "Subject", "<p>Fragment</p>")).rejects.toThrow(
      "Resend API error 422",
    )
  })

  it("includes error body in thrown error message", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    })

    await expect(sendEmail(config, "Subject", "<p>Fragment</p>")).rejects.toThrow(
      "Internal Server Error",
    )
  })
})
