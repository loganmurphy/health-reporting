import { describe, it, expect, vi, beforeEach } from "vitest"
import { generateReport } from "../ai"

const mockAi = {
  run: vi.fn(),
}

describe("generateReport", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns stripped text from AI response", async () => {
    mockAi.run.mockResolvedValue({ response: "<p>report content</p>" })
    const result = await generateReport(mockAi as unknown as Ai, "system prompt", "user content")
    expect(result).toBe("<p>report content</p>")
  })

  it("passes correct model and message structure to ai.run", async () => {
    mockAi.run.mockResolvedValue({ response: "result" })
    await generateReport(mockAi as unknown as Ai, "my system", "my user content")
    expect(mockAi.run).toHaveBeenCalledWith("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "my system" },
        { role: "user", content: "my user content" },
      ],
      max_tokens: 1024,
    })
  })

  it("strips ```html fences if present", async () => {
    mockAi.run.mockResolvedValue({ response: "```html\n<p>report</p>\n```" })
    const result = await generateReport(mockAi as unknown as Ai, "sys", "user")
    expect(result).toBe("<p>report</p>")
  })

  it("strips plain ``` fences", async () => {
    mockAi.run.mockResolvedValue({ response: "```\n<p>report</p>\n```" })
    const result = await generateReport(mockAi as unknown as Ai, "sys", "user")
    expect(result).toBe("<p>report</p>")
  })

  it("handles empty response when result.response is undefined", async () => {
    mockAi.run.mockResolvedValue({})
    const result = await generateReport(mockAi as unknown as Ai, "sys", "user")
    expect(result).toBe("")
  })

  it("trims whitespace from stripped result", async () => {
    mockAi.run.mockResolvedValue({ response: "  <p>content</p>  " })
    const result = await generateReport(mockAi as unknown as Ai, "sys", "user")
    expect(result).toBe("<p>content</p>")
  })
})
