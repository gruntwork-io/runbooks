import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import {
  detectInterpreter,
  isBashInterpreter,
  isValidEnvVarName,
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

// ---------------------------------------------------------------------------
// isValidEnvVarName
// ---------------------------------------------------------------------------

describe("isValidEnvVarName", () => {
  it.each([
    "PATH",
    "HOME",
    "_PRIVATE",
    "__DOUBLE",
    "FOO_BAR_BAZ",
    "x",
    "A1",
    "_",
  ])("accepts %s", (name) => {
    expect(isValidEnvVarName(name)).toBe(true)
  })

  it.each([
    "", // empty
    "1FOO", // leading digit
    "foo.bar", // dot
    "foo-bar", // dash
    "FOO BAR", // space
    "FOO=BAR", // equals
    "FÖÖ", // unicode
    "café", // unicode
  ])("rejects %s", (name) => {
    expect(isValidEnvVarName(name)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// wrapBashScript — behavioural tests
//
// String-matching the wrapped template only catches typos. These tests spawn
// real bash against the wrapper to verify the *runtime contract* — trap
// chaining, log-level filtering, and env capture — that production blocks
// depend on. Skipped on Windows (no /bin/bash) and when bash isn't on PATH.
// ---------------------------------------------------------------------------

const bashAvailable =
  process.platform !== "win32" && nodeFs.existsSync("/bin/bash")

const skipIfNoBash = bashAvailable ? describe : describe.skip

skipIfNoBash("wrapBashScript (real bash)", () => {
  // Per-test temp dir for env / pwd / script files.
  function makeTmp() {
    return nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "script-wrap-test-"))
  }

  function runWrapped(
    userScript: string,
    extraEnv: Record<string, string> = {},
  ): {
    stdout: string
    stderr: string
    exitCode: number
    capturedEnv: Record<string, string> | null
    capturedPwd: string | null
  } {
    const tmp = makeTmp()
    try {
      const envPath = nodePath.join(tmp, "env.txt")
      const pwdPath = nodePath.join(tmp, "pwd.txt")
      const scriptPath = nodePath.join(tmp, "script.sh")

      const wrapped = wrapBashScript(userScript, envPath, pwdPath)
      nodeFs.writeFileSync(scriptPath, wrapped)
      nodeFs.chmodSync(scriptPath, 0o755)

      const res = spawnSync("/bin/bash", [scriptPath], {
        encoding: "utf8",
        env: { ...process.env, ...extraEnv },
      })

      const capturedEnv = nodeFs.existsSync(envPath)
        ? parseNulEnv(nodeFs.readFileSync(envPath, "utf8"))
        : null
      const capturedPwd = nodeFs.existsSync(pwdPath)
        ? nodeFs.readFileSync(pwdPath, "utf8").trim()
        : null

      return {
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        exitCode: res.status ?? -1,
        capturedEnv,
        capturedPwd,
      }
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  function parseNulEnv(data: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const entry of data.split("\0")) {
      if (entry === "") continue
      const idx = entry.indexOf("=")
      if (idx === -1) continue
      out[entry.slice(0, idx)] = entry.slice(idx + 1)
    }
    return out
  }

  it("runs both the user's EXIT trap and our env capture", () => {
    const result = runWrapped(
      `trap 'echo USER_CLEANUP' EXIT
       export MY_VAR=hello
       echo running`,
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("running")
    expect(result.stdout).toContain("USER_CLEANUP")
    // Env capture ran (file exists and contains user var).
    expect(result.capturedEnv).not.toBeNull()
    expect(result.capturedEnv!.MY_VAR).toBe("hello")
  })

  it("only the last user EXIT trap runs, env capture still runs", () => {
    const result = runWrapped(
      `trap 'echo FIRST_CLEANUP' EXIT
       trap 'echo SECOND_CLEANUP' EXIT
       export MARKER=last
       echo run`,
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("SECOND_CLEANUP")
    expect(result.stdout).not.toContain("FIRST_CLEANUP")
    expect(result.capturedEnv!.MARKER).toBe("last")
  })

  it("'trap - EXIT' (reset) still runs env capture", () => {
    const result = runWrapped(
      `trap 'echo SHOULD_NOT_RUN' EXIT
       trap - EXIT
       export AFTER_RESET=yes
       echo done`,
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("done")
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN")
    expect(result.capturedEnv).not.toBeNull()
    expect(result.capturedEnv!.AFTER_RESET).toBe("yes")
  })

  it("log_info/warn/error emit ISO-8601 timestamps and correct level prefixes", () => {
    const result = runWrapped(
      `log_info "info-msg"
       log_warn "warn-msg"
       log_error "err-msg"`,
    )
    expect(result.stdout).toContain("[INFO]")
    expect(result.stdout).toContain("info-msg")
    expect(result.stdout).toContain("[WARN]")
    expect(result.stdout).toContain("warn-msg")
    expect(result.stdout).toContain("[ERROR]")
    expect(result.stdout).toContain("err-msg")
    // ISO-8601 zulu pattern: YYYY-MM-DDTHH:MM:SSZ
    expect(result.stdout).toMatch(
      /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] \[INFO\]/,
    )
  })

  it("log_debug is silent when DEBUG is unset", () => {
    const result = runWrapped(`log_debug "should not appear"`)
    expect(result.stdout).not.toContain("should not appear")
    expect(result.stdout).not.toContain("[DEBUG]")
  })

  it("log_debug fires when DEBUG=true", () => {
    const result = runWrapped(`log_debug "debug-msg"`, { DEBUG: "true" })
    expect(result.stdout).toContain("[DEBUG]")
    expect(result.stdout).toContain("debug-msg")
  })

  it("captures multi-line env values via NUL-delimited env -0", () => {
    const result = runWrapped(
      `export MULTILINE=$'line1\nline2\nline3'
       echo set`,
    )
    expect(result.exitCode).toBe(0)
    expect(result.capturedEnv).not.toBeNull()
    expect(result.capturedEnv!.MULTILINE).toBe("line1\nline2\nline3")
  })

  it("captures the working directory the user cd'd into", () => {
    const tmp = nodeFs.realpathSync(
      nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "pwd-test-")),
    )
    try {
      const result = runWrapped(`cd ${JSON.stringify(tmp)}\necho here`)
      expect(result.exitCode).toBe(0)
      // bash's pwd may return either the symlink path or its realpath
      // depending on the platform; normalize both ends.
      expect(nodeFs.realpathSync(result.capturedPwd!)).toBe(tmp)
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("preserves the user's exit code through the EXIT trap chain", () => {
    const result = runWrapped(`exit 42`)
    expect(result.exitCode).toBe(42)
    // Env capture still ran despite the non-zero exit.
    expect(result.capturedEnv).not.toBeNull()
  })
})
