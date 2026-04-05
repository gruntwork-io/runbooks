import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import {
  detectInterpreter,
  isBashInterpreter,
  wrapBashScript,
  parseEnvCapture,
  parseBlockOutputs,
  captureFilesFromDir,
} from "./script.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"

function runFs<A>(effect: Effect.Effect<A, any, any>, files: Record<string, string> = {}) {
  return Effect.runPromise(effect.pipe(Effect.provide(makeTestFileSystem(files))))
}

// ---------------------------------------------------------------------------
// detectInterpreter
// ---------------------------------------------------------------------------

describe("detectInterpreter", () => {
  it("returns provided language when specified", () => {
    expect(detectInterpreter("#!/bin/bash\necho hi", "python3")).toEqual(["python3", []])
  })

  it("detects #!/usr/bin/env interpreter", () => {
    expect(detectInterpreter("#!/usr/bin/env python3\nprint('hi')", "")).toEqual(["python3", []])
  })

  it("detects #!/usr/bin/env with args", () => {
    expect(detectInterpreter("#!/usr/bin/env -S node --experimental\nconsole.log(1)", "")).toEqual(["-S", ["node", "--experimental"]])
  })

  it("detects #!/bin/bash", () => {
    expect(detectInterpreter("#!/bin/bash\necho hi", "")).toEqual(["bash", []])
  })

  it("detects #!/usr/bin/python3", () => {
    expect(detectInterpreter("#!/usr/bin/python3\nprint(1)", "")).toEqual(["python3", []])
  })

  it("detects shebang with args", () => {
    expect(detectInterpreter("#!/bin/bash -e\necho hi", "")).toEqual(["bash", ["-e"]])
  })

  it("defaults to bash when no shebang", () => {
    expect(detectInterpreter("echo hello", "")).toEqual(["bash", []])
  })

  it("defaults to bash for empty script", () => {
    expect(detectInterpreter("", "")).toEqual(["bash", []])
  })
})

// ---------------------------------------------------------------------------
// isBashInterpreter
// ---------------------------------------------------------------------------

describe("isBashInterpreter", () => {
  it.each([
    "bash",
    "sh",
    "/bin/bash",
    "/bin/sh",
    "/usr/bin/bash",
    "/usr/bin/sh",
  ])("returns true for %s", (interp) => {
    expect(isBashInterpreter(interp)).toBe(true)
  })

  it.each([
    "python3",
    "node",
    "ruby",
    "zsh",
    "/usr/bin/python3",
    "",
  ])("returns false for %s", (interp) => {
    expect(isBashInterpreter(interp)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// wrapBashScript
// ---------------------------------------------------------------------------

describe("wrapBashScript", () => {
  it("includes user script", () => {
    const wrapped = wrapBashScript("echo hello", "/tmp/env", "/tmp/pwd")
    expect(wrapped).toContain("echo hello")
  })

  it("includes env capture paths", () => {
    const wrapped = wrapBashScript("echo hi", "/tmp/env.txt", "/tmp/pwd.txt")
    expect(wrapped).toContain("/tmp/env.txt")
    expect(wrapped).toContain("/tmp/pwd.txt")
  })

  it("includes logging functions", () => {
    const wrapped = wrapBashScript("echo hi", "/tmp/env", "/tmp/pwd")
    expect(wrapped).toContain("log_info")
    expect(wrapped).toContain("log_warn")
    expect(wrapped).toContain("log_error")
    expect(wrapped).toContain("log_debug")
  })

  it("includes trap override mechanism", () => {
    const wrapped = wrapBashScript("echo hi", "/tmp/env", "/tmp/pwd")
    expect(wrapped).toContain("__runbooks_capture_env")
    expect(wrapped).toContain("__runbooks_combined_exit")
    expect(wrapped).toContain("builtin trap __runbooks_combined_exit EXIT")
  })

  it("starts with bash shebang", () => {
    const wrapped = wrapBashScript("echo hi", "/tmp/env", "/tmp/pwd")
    expect(wrapped.startsWith("#!/bin/bash")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseEnvCapture
// ---------------------------------------------------------------------------

describe("parseEnvCapture", () => {
  it("parses NUL-delimited env output", async () => {
    const result = await runFs(
      parseEnvCapture("/env.txt", "/pwd.txt"),
      {
        "/env.txt": "HOME=/home/user\0PATH=/usr/bin\0LANG=en_US.UTF-8\0",
        "/pwd.txt": "/work/dir\n",
      },
    )
    expect(result.env).toEqual({
      HOME: "/home/user",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
    })
    expect(result.pwd).toBe("/work/dir")
  })

  it("handles multiline values in NUL-delimited format", async () => {
    const result = await runFs(
      parseEnvCapture("/env.txt", "/pwd.txt"),
      {
        "/env.txt": "KEY=line1\nline2\nline3\0OTHER=val\0",
        "/pwd.txt": "/work",
      },
    )
    expect(result.env!.KEY).toBe("line1\nline2\nline3")
    expect(result.env!.OTHER).toBe("val")
  })

  it("falls back to newline-delimited parsing", async () => {
    const result = await runFs(
      parseEnvCapture("/env.txt", "/pwd.txt"),
      {
        "/env.txt": "HOME=/home/user\nPATH=/usr/bin\n",
        "/pwd.txt": "/work",
      },
    )
    expect(result.env).toEqual({
      HOME: "/home/user",
      PATH: "/usr/bin",
    })
  })

  it("handles multiline values in newline fallback", async () => {
    const result = await runFs(
      parseEnvCapture("/env.txt", "/pwd.txt"),
      {
        "/env.txt": "SSH_KEY=-----BEGIN RSA-----\nbase64data\n-----END RSA-----\nPATH=/usr/bin\n",
        "/pwd.txt": "/work",
      },
    )
    expect(result.env!.SSH_KEY).toBe("-----BEGIN RSA-----\nbase64data\n-----END RSA-----")
    expect(result.env!.PATH).toBe("/usr/bin")
  })

  it("returns undefined env when env file is missing", async () => {
    const result = await runFs(
      parseEnvCapture("/nonexistent", "/pwd.txt"),
      { "/pwd.txt": "/work" },
    )
    expect(result.env).toBeUndefined()
    expect(result.pwd).toBe("/work")
  })

  it("returns empty pwd when pwd file is missing", async () => {
    const result = await runFs(
      parseEnvCapture("/env.txt", "/nonexistent"),
      { "/env.txt": "A=1\0" },
    )
    expect(result.env).toEqual({ A: "1" })
    expect(result.pwd).toBe("")
  })

  it("returns undefined env for empty env file", async () => {
    const result = await runFs(
      parseEnvCapture("/env.txt", "/pwd.txt"),
      { "/env.txt": "", "/pwd.txt": "/work" },
    )
    expect(result.env).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseBlockOutputs
// ---------------------------------------------------------------------------

describe("parseBlockOutputs", () => {
  it("parses key=value pairs", async () => {
    const result = await runFs(
      parseBlockOutputs("/output.txt"),
      { "/output.txt": "CLUSTER_NAME=my-cluster\nREGION=us-east-1\n" },
    )
    expect(result).toEqual({
      CLUSTER_NAME: "my-cluster",
      REGION: "us-east-1",
    })
  })

  it("preserves leading whitespace in values (trailing stripped by line trim)", async () => {
    const result = await runFs(
      parseBlockOutputs("/output.txt"),
      { "/output.txt": "MSG= hello world \n" },
    )
    // The line is trimmed before parsing, so trailing space is removed
    expect(result.MSG).toBe(" hello world")
  })

  it("skips invalid keys", async () => {
    const result = await runFs(
      parseBlockOutputs("/output.txt"),
      { "/output.txt": "VALID=yes\n123INVALID=no\n-bad=no\n" },
    )
    expect(result).toEqual({ VALID: "yes" })
  })

  it("skips lines without equals sign", async () => {
    const result = await runFs(
      parseBlockOutputs("/output.txt"),
      { "/output.txt": "GOOD=val\nno-equals-here\n" },
    )
    expect(result).toEqual({ GOOD: "val" })
  })

  it("returns empty object for missing file", async () => {
    const result = await runFs(parseBlockOutputs("/nonexistent"), {})
    expect(result).toEqual({})
  })

  it("returns empty object for empty file", async () => {
    const result = await runFs(
      parseBlockOutputs("/output.txt"),
      { "/output.txt": "" },
    )
    expect(result).toEqual({})
  })

  it("handles values containing equals signs", async () => {
    const result = await runFs(
      parseBlockOutputs("/output.txt"),
      { "/output.txt": "CONFIG=key=value=extra\n" },
    )
    expect(result.CONFIG).toBe("key=value=extra")
  })

  it("accepts underscore-prefixed keys", async () => {
    const result = await runFs(
      parseBlockOutputs("/output.txt"),
      { "/output.txt": "_PRIVATE=yes\n__DOUBLE=also\n" },
    )
    expect(result).toEqual({ _PRIVATE: "yes", __DOUBLE: "also" })
  })
})

// ---------------------------------------------------------------------------
// captureFilesFromDir
// ---------------------------------------------------------------------------

describe("captureFilesFromDir", () => {
  it("copies files and returns metadata", async () => {
    const files: Record<string, string> = {
      "/src/file1.txt": "hello",
      "/src/file2.json": '{"a":1}',
    }
    const result = await runFs(
      captureFilesFromDir("/src", "/dest"),
      files,
    )
    expect(result).toHaveLength(2)
    expect(result.map((f) => f.path).sort()).toEqual(["file1.txt", "file2.json"])
    // Files should be copied to dest
    expect(files["/dest/file1.txt"]).toBe("hello")
    expect(files["/dest/file2.json"]).toBe('{"a":1}')
  })

  it("returns empty array for empty source directory", async () => {
    // No files under /src/
    const result = await runFs(captureFilesFromDir("/src", "/dest"), {})
    expect(result).toEqual([])
  })

  it("handles nested directories", async () => {
    const files: Record<string, string> = {
      "/src/sub/deep/file.txt": "nested",
    }
    const result = await runFs(
      captureFilesFromDir("/src", "/dest"),
      files,
    )
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("sub/deep/file.txt")
  })

  it("reports file sizes", async () => {
    const result = await runFs(
      captureFilesFromDir("/src", "/dest"),
      { "/src/file.txt": "12345" },
    )
    expect(result[0].size).toBe(5)
  })
})
