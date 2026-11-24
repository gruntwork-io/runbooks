import { describe, it, expect } from "bun:test"
import { LOG_CHANNELS, logChannelFiles, logTimestamp, tagLogLine } from "./logChannels.ts"

describe("LOG_CHANNELS", () => {
  it("names one RUNBOOK_<LEVEL>_LOG file per level", () => {
    expect(logChannelFiles("/tmp/logs", LOG_CHANNELS)).toEqual([
      {
        level: "INFO",
        envVar: "RUNBOOK_INFO_LOG",
        fileName: "info.log",
        path: "/tmp/logs/info.log",
      },
      {
        level: "WARN",
        envVar: "RUNBOOK_WARN_LOG",
        fileName: "warn.log",
        path: "/tmp/logs/warn.log",
      },
      {
        level: "ERROR",
        envVar: "RUNBOOK_ERROR_LOG",
        fileName: "error.log",
        path: "/tmp/logs/error.log",
      },
      {
        level: "DEBUG",
        envVar: "RUNBOOK_DEBUG_LOG",
        fileName: "debug.log",
        path: "/tmp/logs/debug.log",
      },
    ])
  })
})

describe("logTimestamp", () => {
  it("formats UTC, to the second", () => {
    expect(logTimestamp(new Date("2026-09-30T12:34:56.789Z"))).toBe("2026-09-30T12:34:56Z")
  })
})

describe("tagLogLine", () => {
  const at = new Date("2026-09-30T12:00:00.500Z")

  it("tags a line with its file's level and the read time, padding the level", () => {
    expect(tagLogLine("Error: no provider", "ERROR", at)).toBe(
      "[2026-09-30T12:00:00Z] [ERROR] Error: no provider",
    )
    expect(tagLogLine("planning", "INFO", at)).toBe("[2026-09-30T12:00:00Z] [INFO]  planning")
    expect(tagLogLine("careful", "WARN", at)).toBe("[2026-09-30T12:00:00Z] [WARN]  careful")
    expect(tagLogLine("x=1", "DEBUG", at)).toBe("[2026-09-30T12:00:00Z] [DEBUG] x=1")
  })

  it("tags a line that already looks like a log line, so the file's level wins", () => {
    // Untagged, either line would parse as an INFO line in the log view.
    expect(tagLogLine("[INFO] tool says hi", "ERROR", at)).toBe(
      "[2026-09-30T12:00:00Z] [ERROR] [INFO] tool says hi",
    )
    expect(tagLogLine("[2026-09-30T11:59:59Z] [INFO]  formatted", "ERROR", at)).toBe(
      "[2026-09-30T12:00:00Z] [ERROR] [2026-09-30T11:59:59Z] [INFO]  formatted",
    )
  })

  it("leaves blank lines blank", () => {
    expect(tagLogLine("", "ERROR", at)).toBe("")
    expect(tagLogLine("   ", "ERROR", at)).toBe("   ")
  })
})
