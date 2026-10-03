import { describe, it, expect } from "bun:test"
import {
  LEVEL_LOG_CHANNELS,
  LOG_CHANNELS,
  RUNBOOK_LOG_CHANNEL,
  logChannelFiles,
  logTimestamp,
  orderLogChannelLines,
  tagLogLine,
} from "./logChannels.ts"

describe("LOG_CHANNELS", () => {
  it("names RUNBOOK_LOG, for the helpers, and then one RUNBOOK_<LEVEL>_LOG file per level", () => {
    expect(logChannelFiles("/tmp/logs", LOG_CHANNELS)).toEqual([
      {
        level: null,
        envVar: "RUNBOOK_LOG",
        fileName: "runbook.log",
        path: "/tmp/logs/runbook.log",
      },
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
    expect(LOG_CHANNELS).toEqual([RUNBOOK_LOG_CHANNEL, ...LEVEL_LOG_CHANNELS])
  })
})

describe("logTimestamp", () => {
  it("formats like the helpers' _log_timestamp: UTC, to the second", () => {
    expect(logTimestamp(new Date("2026-09-30T12:34:56.789Z"))).toBe("2026-09-30T12:34:56Z")
  })
})

describe("tagLogLine", () => {
  const at = new Date("2026-09-30T12:00:00.500Z")

  it("tags a line written straight to a file with the file's level, padded like the helpers", () => {
    expect(tagLogLine("Error: no provider", "ERROR", at)).toBe(
      "[2026-09-30T12:00:00Z] [ERROR] Error: no provider",
    )
    expect(tagLogLine("planning", "INFO", at)).toBe("[2026-09-30T12:00:00Z] [INFO]  planning")
    expect(tagLogLine("careful", "WARN", at)).toBe("[2026-09-30T12:00:00Z] [WARN]  careful")
    expect(tagLogLine("x=1", "DEBUG", at)).toBe("[2026-09-30T12:00:00Z] [DEBUG] x=1")
  })

  it("leaves a helper's line alone, whatever file it is in", () => {
    const line = "[2026-09-30T11:59:59Z] [INFO]  from log_info"
    expect(tagLogLine(line, "INFO", at)).toBe(line)
    expect(tagLogLine(line, "ERROR", at)).toBe(line)
  })

  it("tags a line that only looks like a log line, so the file's level wins", () => {
    // Unprefixed, "[INFO] ..." would parse as an INFO line in the log view.
    expect(tagLogLine("[INFO] tool says hi", "ERROR", at)).toBe(
      "[2026-09-30T12:00:00Z] [ERROR] [INFO] tool says hi",
    )
  })

  it("leaves blank lines blank", () => {
    expect(tagLogLine("", "ERROR", at)).toBe("")
    expect(tagLogLine("   ", "ERROR", at)).toBe("   ")
  })

  it("uses the short [LEVEL] prefix without a read time", () => {
    expect(tagLogLine("Error: no provider", "ERROR")).toBe("[ERROR] Error: no provider")
    expect(tagLogLine("planning", "INFO")).toBe("[INFO]  planning")
  })
})

describe("orderLogChannelLines", () => {
  it("merges the files by the helpers' timestamps, keeping each file's order", () => {
    expect(
      orderLogChannelLines([
        {
          level: "INFO",
          text: "[2026-09-30T12:00:00Z] [INFO]  start\n[2026-09-30T12:00:05Z] [INFO]  done\n",
        },
        { level: "WARN", text: "[2026-09-30T12:00:02Z] [WARN]  slow\n" },
        { level: "ERROR", text: "" },
        { level: "DEBUG", text: "[2026-09-30T12:00:00Z] [DEBUG] same second as start\n" },
      ]),
    ).toEqual([
      "[2026-09-30T12:00:00Z] [INFO]  start",
      "[2026-09-30T12:00:00Z] [DEBUG] same second as start",
      "[2026-09-30T12:00:02Z] [WARN]  slow",
      "[2026-09-30T12:00:05Z] [INFO]  done",
    ])
  })

  it("sorts a line written straight to a file with the next helper line in it, or else the last", () => {
    expect(
      orderLogChannelLines([
        {
          level: "INFO",
          text: "[2026-09-30T12:00:00Z] [INFO]  creating\n[2026-09-30T12:00:09Z] [INFO]  cleaning up\n",
        },
        {
          level: "ERROR",
          text:
            "AccessDenied: not allowed\r\n" +
            "[2026-09-30T12:00:03Z] [ERROR] create failed\n" +
            "details after it\n",
        },
      ]),
    ).toEqual([
      "[2026-09-30T12:00:00Z] [INFO]  creating",
      "[ERROR] AccessDenied: not allowed",
      "[2026-09-30T12:00:03Z] [ERROR] create failed",
      "[ERROR] details after it",
      "[2026-09-30T12:00:09Z] [INFO]  cleaning up",
    ])
  })

  it("sorts lines after a file's last helper line at the time the file was last written", () => {
    expect(
      orderLogChannelLines([
        {
          level: "INFO",
          text: "[2026-09-30T12:00:00Z] [INFO]  start\n[2026-09-30T12:00:09Z] [INFO]  done\n",
        },
        // No helper lines at all, and a last line with no newline.
        {
          level: "ERROR",
          text: "raw one\nraw two",
          lastWritten: new Date("2026-09-30T12:00:04.700Z"),
        },
      ]),
    ).toEqual([
      "[2026-09-30T12:00:00Z] [INFO]  start",
      "[ERROR] raw one",
      "[ERROR] raw two",
      "[2026-09-30T12:00:09Z] [INFO]  done",
    ])
  })

  it("puts a file without helper lines or a write time first", () => {
    expect(
      orderLogChannelLines([
        { level: "INFO", text: "[2026-09-30T12:00:00Z] [INFO]  start\n" },
        { level: "WARN", text: "raw\n" },
      ]),
    ).toEqual(["[WARN]  raw", "[2026-09-30T12:00:00Z] [INFO]  start"])
  })
})
