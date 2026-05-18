const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

interface AiTextResponse {
  response?: string
}

export async function generateReport(
  ai: Ai,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const result = (await ai.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: 1024,
  })) as AiTextResponse

  const text = result.response ?? ""
  return stripMarkdownFences(text)
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```[\w]*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim()
}
