import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as child_process from "node:child_process"
import {
  loadDevVars,
  saveDevVars,
  openBrowser,
  copyToClipboard,
  localTimeToCron,
  updateWranglerCrons,
} from "../../scripts/utils"

vi.mock("node:fs")
vi.mock("node:child_process")

const mockFs = vi.mocked(fs)
const mockSpawnSync = vi.mocked(child_process.spawnSync)

describe("updateWranglerCrons", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("replaces existing crons array and existing MORNING_CRON / EVENING_CRON vars", () => {
    const input = `{
  "triggers": { "crons": ["30 15 * * *", "0 2 * * *"] },
  "vars": {
    "MORNING_CRON": "30 15 * * *",
    "EVENING_CRON": "0 2 * * *"
  }
}`
    mockFs.readFileSync.mockReturnValue(input)
    mockFs.writeFileSync.mockReturnValue(undefined)

    updateWranglerCrons("/wrangler.jsonc", "0 14 * * *", "0 1 * * *", -5)

    const written = mockFs.writeFileSync.mock.calls[0]![1] as string
    expect(written).toContain('"crons": ["0 14 * * *", "0 1 * * *"]')
    expect(written).toContain('"MORNING_CRON": "0 14 * * *"')
    expect(written).toContain('"EVENING_CRON": "0 1 * * *"')
    expect(written).toContain('"UTC_OFFSET": "-5"')
  })

  it("inserts MORNING_CRON and EVENING_CRON when vars block has no existing cron vars", () => {
    const input = `{
  "triggers": { "crons": ["MORNING_CRON_UTC", "EVENING_CRON_UTC"] },
  "vars": {
    "OTHER_VAR": "value"
  }
}`
    mockFs.readFileSync.mockReturnValue(input)
    mockFs.writeFileSync.mockReturnValue(undefined)

    updateWranglerCrons("/wrangler.jsonc", "30 15 * * *", "0 2 * * *", -6)

    const written = mockFs.writeFileSync.mock.calls[0]![1] as string
    expect(written).toContain('"crons": ["30 15 * * *", "0 2 * * *"]')
    expect(written).toContain('"MORNING_CRON": "30 15 * * *"')
    expect(written).toContain('"EVENING_CRON": "0 2 * * *"')
    expect(written).toContain('"UTC_OFFSET": "-6"')
  })
})

describe("localTimeToCron", () => {
  it("converts 9:30 AM at UTC-6 to correct UTC cron", () => {
    expect(localTimeToCron("09:30", -6)).toBe("30 15 * * *")
  })

  it("converts 8:00 PM at UTC-6 to correct UTC cron", () => {
    expect(localTimeToCron("20:00", -6)).toBe("0 2 * * *")
  })

  it("handles UTC offset 0 (no conversion)", () => {
    expect(localTimeToCron("08:00", 0)).toBe("0 8 * * *")
  })

  it("handles positive UTC offset (east of UTC)", () => {
    // 09:00 local at UTC+1 → 08:00 UTC
    expect(localTimeToCron("09:00", 1)).toBe("0 8 * * *")
  })

  it("wraps midnight correctly for late-night local time", () => {
    // 22:00 local at UTC-6 → 04:00 UTC next day (hour 4)
    expect(localTimeToCron("22:00", -6)).toBe("0 4 * * *")
  })

  it("wraps correctly when UTC hour would go negative", () => {
    // 01:00 local at UTC+5 → 20:00 UTC previous day (hour 20)
    expect(localTimeToCron("01:00", 5)).toBe("0 20 * * *")
  })
})

describe("loadDevVars", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns empty object when file does not exist", () => {
    mockFs.existsSync.mockReturnValue(false)
    const result = loadDevVars("/path/to/.dev.vars")
    expect(result).toEqual({})
  })

  it("parses key=value pairs from file", () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue("KEY1=value1\nKEY2=value2\n")
    const result = loadDevVars("/path/to/.dev.vars")
    expect(result).toEqual({ KEY1: "value1", KEY2: "value2" })
  })

  it("skips comment lines starting with #", () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue("# This is a comment\nKEY=value\n")
    const result = loadDevVars("/path/to/.dev.vars")
    expect(result).toEqual({ KEY: "value" })
  })

  it("skips empty lines", () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue("\n\nKEY=value\n\n")
    const result = loadDevVars("/path/to/.dev.vars")
    expect(result).toEqual({ KEY: "value" })
  })

  it("skips lines without = sign", () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue("INVALID_LINE\nKEY=value\n")
    const result = loadDevVars("/path/to/.dev.vars")
    expect(result).toEqual({ KEY: "value" })
  })

  it("handles values containing = signs", () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue("KEY=value=with=equals\n")
    const result = loadDevVars("/path/to/.dev.vars")
    expect(result).toEqual({ KEY: "value=with=equals" })
  })
})

describe("saveDevVars", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("writes merged vars to file", () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue("EXISTING=old_value\n")
    mockFs.writeFileSync.mockReturnValue(undefined)

    saveDevVars("/path/to/.dev.vars", { NEW_KEY: "new_value" })

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/path/to/.dev.vars",
      expect.stringContaining("NEW_KEY=new_value"),
    )
  })

  it("overwrites existing keys with new values", () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue("KEY=old_value\n")
    mockFs.writeFileSync.mockReturnValue(undefined)

    saveDevVars("/path/to/.dev.vars", { KEY: "new_value" })

    const written = mockFs.writeFileSync.mock.calls[0]![1] as string
    expect(written).toContain("KEY=new_value")
    expect(written).not.toContain("KEY=old_value")
  })

  it("creates new file when file does not exist", () => {
    mockFs.existsSync.mockReturnValue(false)
    mockFs.writeFileSync.mockReturnValue(undefined)

    saveDevVars("/path/to/.dev.vars", { KEY: "value" })

    expect(mockFs.writeFileSync).toHaveBeenCalledWith("/path/to/.dev.vars", "KEY=value\n")
  })
})

describe("openBrowser", () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    mockSpawnSync.mockReturnValue({
      status: 0,
      pid: 1,
      output: [],
      stderr: Buffer.from(""),
      stdout: Buffer.from(""),
      signal: null,
    })
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("uses 'open' on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    openBrowser("https://example.com")
    expect(mockSpawnSync).toHaveBeenCalledWith("open", ["https://example.com"], { stdio: "ignore" })
  })

  it("uses 'cmd /c start' on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    openBrowser("https://example.com")
    expect(mockSpawnSync).toHaveBeenCalledWith("cmd", ["/c", "start", "https://example.com"], {
      stdio: "ignore",
    })
  })

  it("uses 'xdg-open' on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    openBrowser("https://example.com")
    expect(mockSpawnSync).toHaveBeenCalledWith("xdg-open", ["https://example.com"], {
      stdio: "ignore",
    })
  })
})

describe("copyToClipboard", () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("uses 'pbcopy' on macOS and returns true on success", () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    mockSpawnSync.mockReturnValue({
      status: 0,
      pid: 1,
      output: [],
      stderr: Buffer.from(""),
      stdout: Buffer.from(""),
      signal: null,
    })
    const result = copyToClipboard("hello")
    expect(mockSpawnSync).toHaveBeenCalledWith("pbcopy", [], {
      input: "hello",
      stdio: ["pipe", "ignore", "ignore"],
    })
    expect(result).toBe(true)
  })

  it("uses 'clip' on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    mockSpawnSync.mockReturnValue({
      status: 0,
      pid: 1,
      output: [],
      stderr: Buffer.from(""),
      stdout: Buffer.from(""),
      signal: null,
    })
    copyToClipboard("hello")
    expect(mockSpawnSync).toHaveBeenCalledWith("clip", [], {
      input: "hello",
      stdio: ["pipe", "ignore", "ignore"],
    })
  })

  it("uses 'xclip -selection clipboard' on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    mockSpawnSync.mockReturnValue({
      status: 0,
      pid: 1,
      output: [],
      stderr: Buffer.from(""),
      stdout: Buffer.from(""),
      signal: null,
    })
    copyToClipboard("hello")
    expect(mockSpawnSync).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], {
      input: "hello",
      stdio: ["pipe", "ignore", "ignore"],
    })
  })

  it("returns false when command fails", () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    mockSpawnSync.mockReturnValue({
      status: 1,
      pid: 1,
      output: [],
      stderr: Buffer.from(""),
      stdout: Buffer.from(""),
      signal: null,
    })
    const result = copyToClipboard("hello")
    expect(result).toBe(false)
  })
})
