import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { inspect } from "node:util"
import {
  resolveScriptRunner,
  type ScriptSource,
  prepareScript,
  parseRunbookEnv,
  parseRunbookEnvContent,
  parseBlockOutputs,
  parseBlockOutputsContent,
  captureFilesFromDir,
} from "./script.ts"
import { encodeOutputs, isSensitiveOutput, revealOutput } from "./outputValues.ts"
import { LOG_CHANNELS, logChannelFiles } from "./logChannels.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"
import type { FileSystem } from "../../services/FileSystem.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"

function runFs<A, E>(effect: Effect.Effect<A, E, FileSystem>, files: Record<string, string> = {}) {
  return Effect.runPromise(effect.pipe(Effect.provide(makeTestFileSystem(files))))
}

// ---------------------------------------------------------------------------
// resolveScriptRunner
// ---------------------------------------------------------------------------

/** resolveScriptRunner's answer, failing the test when it refuses the script. */
function runnerFor(
  content: string,
  source: Partial<ScriptSource> = {},
  platform: NodeJS.Platform = "linux",
) {
  const runner = resolveScriptRunner(content, { path: "", interpreter: "", ...source }, platform)
  if (!runner.ok) throw new Error(runner.error)
  return runner
}

describe("resolveScriptRunner", () => {
  it.each([
    "#!/bin/bash\necho hi",
    "#!/usr/bin/env bash\necho hi",
    "#!/usr/local/bin/bash -e\necho hi",
    "#!/bin/sh\necho hi",
    "#!/usr/bin/env -S sh -e\necho hi",
    "#!/usr/bin/env FOO=1 -i sh\necho hi",
  ])("runs a script with a shebang as itself on macOS and Linux: %j", (content) => {
    expect(runnerFor(content).launch).toEqual({ kind: "self" })
    expect(runnerFor(content, {}, "darwin").launch).toEqual({ kind: "self" })
  })

  it("puts the logging functions after a bash or sh shebang line", () => {
    const { script } = runnerFor("#!/usr/bin/env bash\necho hi")
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true)
    expect(script).toContain("log_info()")
    expect(script.endsWith("\necho hi")).toBe(true)
  })

  it("leaves a script for another interpreter as written", () => {
    const content = "#!/usr/bin/env python3\nprint(1)"
    expect(runnerFor(content, { path: "check.sh" })).toEqual({
      ok: true,
      launch: { kind: "self" },
      script: content,
      fileName: "script.sh",
    })
  })

  it("starts the program a shebang names on Windows, which can't run a file by its shebang", () => {
    expect(runnerFor("#!/usr/bin/env -S node --no-warnings\n1", {}, "win32").launch).toEqual({
      kind: "interpreter",
      command: "node",
      args: ["--no-warnings"],
    })
    expect(runnerFor("#!/bin/bash -e\necho hi", {}, "win32").launch).toEqual({
      kind: "interpreter",
      command: "bash",
      args: ["-e"],
    })
  })

  it("runs an inline command or a file without an extension with bash, logging functions first", () => {
    for (const scriptPath of ["", "scripts/check"]) {
      const runner = runnerFor("echo hi", { path: scriptPath })
      expect(runner.launch).toEqual({ kind: "interpreter", command: "bash", args: [] })
      expect(runner.script.startsWith("\n# --- Runbooks Logging Functions ---")).toBe(true)
      expect(runner.fileName).toBe("script.sh")
    }
  })

  it.each([
    ["deploy.sh", "bash"],
    ["deploy.BASH", "bash"],
    ["check.py", "python3"],
    ["check.mjs", "node"],
    ["check.rb", "ruby"],
    ["Check.ps1", "pwsh"],
  ])("runs %s without a shebang with %s, keeping its extension", (scriptPath, command) => {
    const runner = runnerFor("work", { path: `scripts/${scriptPath}` })
    expect(runner.launch).toEqual({ kind: "interpreter", command, args: [] })
    expect(runner.fileName).toBe(`script${nodePath.extname(scriptPath).toLowerCase()}`)
  })

  it("refuses a file without a shebang whose extension names no program", () => {
    expect(
      resolveScriptRunner("console.log(1)", { path: "scripts/check.ts", interpreter: "" }, "linux"),
    ).toEqual({
      ok: false,
      error:
        "Runbooks can't tell which program runs check.ts. " +
        "Add a shebang line, such as #!/usr/bin/env python3, to the top of the script, " +
        "or set the block's interpreter prop.",
    })
  })

  it("runs a script without a shebang with the interpreter prop, over its extension", () => {
    expect(runnerFor("print(1)", { interpreter: "python3" }).launch).toEqual({
      kind: "interpreter",
      command: "python3",
      args: [],
    })
    expect(runnerFor("x", { path: "check.ts", interpreter: " deno  run " }).launch).toEqual({
      kind: "interpreter",
      command: "deno",
      args: ["run"],
    })
    expect(runnerFor("echo hi", { path: "check.sh", interpreter: "zsh" }).script).toBe("echo hi")
  })

  it("gives a script the logging functions when the interpreter prop is bash or sh", () => {
    for (const interpreter of ["sh", "/bin/bash -e"]) {
      expect(runnerFor("echo hi", { interpreter }).script).toContain("log_info()")
    }
  })

  it("runs a script with a shebang as itself, whatever the interpreter prop says", () => {
    expect(runnerFor("#!/usr/bin/env bash\necho hi", { interpreter: "python3" }).launch).toEqual({
      kind: "self",
    })
  })

  it("reads a #! line that names no program as no shebang", () => {
    expect(runnerFor("#!\necho hi").launch).toEqual({
      kind: "interpreter",
      command: "bash",
      args: [],
    })
  })
})

// ---------------------------------------------------------------------------
// parseRunbookEnvContent
// ---------------------------------------------------------------------------

describe("parseRunbookEnvContent", () => {
  it("parses NAME=value lines, keeping values as written", () => {
    expect(parseRunbookEnvContent('A=1\nB= spaced \nC="quoted"\nD=x=y\nE=\n')).toEqual({
      env: { A: "1", B: " spaced ", C: '"quoted"', D: "x=y", E: "" },
      problems: [],
    })
  })

  it("parses a NAME<<DELIMITER value across lines", () => {
    const content = "KEY<<EOF\n-----BEGIN-----\n\nabc\n-----END-----\nEOF\nAFTER=1\n"
    expect(parseRunbookEnvContent(content)).toEqual({
      env: { KEY: "-----BEGIN-----\n\nabc\n-----END-----", AFTER: "1" },
      problems: [],
    })
  })

  it("reads a line with = before << as NAME=value", () => {
    expect(parseRunbookEnvContent("A=x<<y\n").env).toEqual({ A: "x<<y" })
  })

  it("lets a later line for the same name win", () => {
    expect(parseRunbookEnvContent("A=1\nA=2\n").env).toEqual({ A: "2" })
  })

  it("accepts \\r\\n line endings and a byte order mark", () => {
    expect(parseRunbookEnvContent("\uFEFFA=1\r\nB<<EOF\r\nx\r\nEOF\r\n").env).toEqual({
      A: "1",
      B: "x",
    })
  })

  it("sets a variable whose name is also an Object.prototype property", () => {
    expect(Object.entries(parseRunbookEnvContent("__proto__=x\n").env)).toEqual([
      ["__proto__", "x"],
    ])
  })

  it("skips and reports lines that set nothing", () => {
    expect(
      parseRunbookEnvContent(
        "no equals\n1BAD=x\nRUNBOOK_OUTPUT=x\nREPO_FILES=x\nOK=1\nM<<\nNUL=a\0b\nOPEN<<EOF\nNEVER=closed\n",
      ),
    ).toEqual({
      env: { OK: "1" },
      problems: [
        "RUNBOOK_ENV line 1: expected NAME=value or NAME<<DELIMITER. The line was ignored.",
        "RUNBOOK_ENV line 2: the name is not a variable name. Use letters, digits and underscores, and don't start with a digit. The line was ignored.",
        "RUNBOOK_ENV line 3: RUNBOOK_OUTPUT is a variable Runbooks sets for every script. The line was ignored.",
        "RUNBOOK_ENV line 4: REPO_FILES is a variable Runbooks sets for every script. The line was ignored.",
        "RUNBOOK_ENV line 6: a NAME<< line has no delimiter. The line was ignored.",
        "RUNBOOK_ENV line 7: NUL's value has a NUL character, which no environment variable can hold. The line was ignored.",
        "RUNBOOK_ENV line 8: a NAME<<DELIMITER value has no line that closes it. It and the lines after it were ignored.",
      ],
    })
  })

  it.each([
    "BASH_ENV",
    "ENV",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_FUNC_ls%%",
  ])("refuses %s, which makes later programs run code", (name) => {
    const { env } = parseRunbookEnvContent(`${name}=/tmp/evil\n`)
    expect(env).toEqual({})
  })

  it("refuses a startup variable a newline in a copied value adds", () => {
    // What `echo "PR_TITLE=$TITLE" >> "$RUNBOOK_ENV"` writes for a hostile title
    const { env, problems } = parseRunbookEnvContent("PR_TITLE=hello\nBASH_ENV=/tmp/evil\n")

    expect(env).toEqual({ PR_TITLE: "hello" })
    expect(problems).toEqual([
      "RUNBOOK_ENV line 2: BASH_ENV makes programs run code as they start, so a script can't set it. The line was ignored.",
    ])
  })

  it("never quotes text that isn't a known variable, which may be a secret written without its name", () => {
    const { problems } = parseRunbookEnvContent(
      "sk-live-4f9a/b+c==\nhunter2secret<<\nsk-live-4f9a<<EOF\nhunter2secret<<abc\n",
    )

    expect(problems).toHaveLength(3)
    for (const problem of problems) {
      expect(problem).not.toContain("4f9a")
      expect(problem).not.toContain("hunter2")
    }
  })

  it("reports the first 20 problems, then counts the rest", () => {
    const { problems } = parseRunbookEnvContent("junk\n".repeat(25))

    expect(problems).toHaveLength(21)
    expect(problems.at(-1)).toBe("RUNBOOK_ENV: 5 more lines were ignored.")
  })
})

describe("parseRunbookEnv", () => {
  it("reads the file", async () => {
    const result = await runFs(parseRunbookEnv("/env.txt"), { "/env.txt": "A=1\n" })
    expect(result).toEqual({ env: { A: "1" }, problems: [] })
  })

  it("sets nothing when the script deleted the file", async () => {
    const result = await runFs(parseRunbookEnv("/env.txt"))
    expect(result).toEqual({ env: {}, problems: [] })
  })
})

// ---------------------------------------------------------------------------
// parseBlockOutputs
// ---------------------------------------------------------------------------

describe("parseBlockOutputs", () => {
  it("parses key=value pairs", async () => {
    const result = await runFs(parseBlockOutputs("/output.txt"), {
      "/output.txt": "CLUSTER_NAME=my-cluster\nREGION=us-east-1\n",
    })
    expect(result).toEqual({
      CLUSTER_NAME: "my-cluster",
      REGION: "us-east-1",
    })
  })

  it("preserves leading whitespace in values (trailing stripped by line trim)", async () => {
    const result = await runFs(parseBlockOutputs("/output.txt"), {
      "/output.txt": "MSG= hello world \n",
    })
    // The line is trimmed before parsing, so trailing space is removed
    expect(result.MSG).toBe(" hello world")
  })

  it("skips invalid keys", async () => {
    const result = await runFs(parseBlockOutputs("/output.txt"), {
      "/output.txt": "VALID=yes\n123INVALID=no\n-bad=no\n",
    })
    expect(result).toEqual({ VALID: "yes" })
  })

  it("skips lines without equals sign", async () => {
    const result = await runFs(parseBlockOutputs("/output.txt"), {
      "/output.txt": "GOOD=val\nno-equals-here\n",
    })
    expect(result).toEqual({ GOOD: "val" })
  })

  it("returns empty object for missing file", async () => {
    const result = await runFs(parseBlockOutputs("/nonexistent"), {})
    expect(result).toEqual({})
  })

  it("returns empty object for empty file", async () => {
    const result = await runFs(parseBlockOutputs("/output.txt"), { "/output.txt": "" })
    expect(result).toEqual({})
  })

  it("handles values containing equals signs", async () => {
    const result = await runFs(parseBlockOutputs("/output.txt"), {
      "/output.txt": "CONFIG=key=value=extra\n",
    })
    expect(result.CONFIG).toBe("key=value=extra")
  })

  it("accepts underscore-prefixed keys", async () => {
    const result = await runFs(parseBlockOutputs("/output.txt"), {
      "/output.txt": "_PRIVATE=yes\n__DOUBLE=also\n",
    })
    expect(result).toEqual({ _PRIVATE: "yes", __DOUBLE: "also" })
  })

  it("wraps a value the sensitive: prefix marks", async () => {
    const result = await runFs(parseBlockOutputs("/output.txt"), {
      "/output.txt": "AWS_REGION=us-west-2\nsensitive:AWS_SECRET_ACCESS_KEY=abc/123\n",
    })
    expect(encodeOutputs(result)).toEqual({
      AWS_REGION: { value: "us-west-2", sensitive: false },
      AWS_SECRET_ACCESS_KEY: { value: "abc/123", sensitive: true },
    })
  })
})

describe("parseBlockOutputsContent", () => {
  it("keeps value whitespace and skips invalid or empty keys", () => {
    expect(parseBlockOutputsContent("MSG= hi\n=no-key\nbad-key=x\nOK=1\n")).toEqual({
      MSG: " hi",
      OK: "1",
    })
  })

  describe("sensitive: prefix", () => {
    // toEqual can't see inside a Redacted, so compare each output's real
    // value and whether it's sensitive
    const parse = (content: string) => encodeOutputs(parseBlockOutputsContent(content))

    it("stores the value under the plain key, wrapped as sensitive", () => {
      const outputs = parseBlockOutputsContent("sensitive:TOKEN=s3cr3t\nUSER=alice\n")
      expect(Object.keys(outputs)).toEqual(["TOKEN", "USER"])
      expect(isSensitiveOutput(outputs.TOKEN!)).toBe(true)
      expect(revealOutput(outputs.TOKEN)).toBe("s3cr3t")
      expect(outputs.USER).toBe("alice")
    })

    it("never shows the value when the parsed outputs are printed", () => {
      const outputs = parseBlockOutputsContent("sensitive:TOKEN=s3cr3t\nUSER=alice\n")
      expect(String(outputs.TOKEN)).toBe("<redacted>")
      expect(JSON.stringify(outputs)).toBe('{"TOKEN":"<redacted>","USER":"alice"}')
      expect(inspect(outputs)).not.toContain("s3cr3t")
    })

    it("trims whitespace between the prefix and the key", () => {
      expect(parse("sensitive: TOKEN =s3cr3t\n")).toEqual({
        TOKEN: { value: "s3cr3t", sensitive: true },
      })
    })

    it("keeps the value's leading whitespace, as for a plain key", () => {
      expect(parse("sensitive:TOKEN= s3cr3t\n")).toEqual({
        TOKEN: { value: " s3cr3t", sensitive: true },
      })
    })

    it("skips an invalid or empty key after the prefix", () => {
      expect(
        parseBlockOutputsContent("sensitive:bad-key=x\nsensitive:=y\nsensitive:1ABC=z\n"),
      ).toEqual({})
    })

    it("recognises only the exact lowercase prefix", () => {
      expect(parseBlockOutputsContent("SENSITIVE:K=v\nSensitive:J=w\n")).toEqual({})
    })

    it("doesn't treat sensitive: inside a value as a marker", () => {
      expect(parse("NOTE=sensitive:TOKEN=x\n")).toEqual({
        NOTE: { value: "sensitive:TOKEN=x", sensitive: false },
      })
    })

    it("keeps a key sensitive when a later plain line rewrites it", () => {
      expect(parse("sensitive:T=a\nT=b\n")).toEqual({ T: { value: "b", sensitive: true } })
    })

    it("marks a key sensitive when a later line adds the prefix", () => {
      expect(parse("T=a\nsensitive:T=b\n")).toEqual({ T: { value: "b", sensitive: true } })
    })
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
    const result = await runFs(captureFilesFromDir("/src", "/dest"), files)
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
    const result = await runFs(captureFilesFromDir("/src", "/dest"), files)
    expect(result).toHaveLength(1)
    expect(result[0]!.path).toBe("sub/deep/file.txt")
  })

  it("reports file sizes", async () => {
    const result = await runFs(captureFilesFromDir("/src", "/dest"), { "/src/file.txt": "12345" })
    expect(result[0]!.size).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Logging functions — behavioural tests
//
// These spawn real bash and sh against the logging functions
// resolveScriptRunner puts before a script. Skipped on Windows (no /bin/bash)
// and when bash isn't on PATH.
// ---------------------------------------------------------------------------

const bashAvailable = process.platform !== "win32" && nodeFs.existsSync("/bin/bash")

const skipIfNoBash = bashAvailable ? describe : describe.skip

skipIfNoBash("logging functions (real shell)", () => {
  // Per-test temp dir for env / pwd / script files.
  function makeTmp() {
    return nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "script-wrap-test-"))
  }

  /**
   * process.env without what a developer's shell may have set: a BASH_ENV
   * that loads their own logging.sh, its load guard, and log file variables.
   */
  function cleanEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.BASH_ENV
    delete env._RUNBOOKS_LOGGING_LOADED
    for (const { envVar } of LOG_CHANNELS) delete env[envVar]
    return env
  }

  /**
   * Empty log files under `dir`, as the executor makes them, in a directory
   * whose name has a space so the helpers must quote the path. `read` returns
   * RUNBOOK_LOG's contents, and the per-level files' contents joined.
   */
  function makeLogFiles(dir: string) {
    const logDir = nodePath.join(dir, "log files")
    nodeFs.mkdirSync(logDir)
    const files = logChannelFiles(logDir, LOG_CHANNELS)
    for (const { path } of files) nodeFs.writeFileSync(path, "")
    const contents = (level: boolean) =>
      files
        .filter((f) => (f.level !== null) === level)
        .map((f) => nodeFs.readFileSync(f.path, "utf8"))
        .join("")
    return {
      env: Object.fromEntries(files.map((f) => [f.envVar, f.path])),
      read: () => ({ log: contents(false), levelLogs: contents(true) }),
    }
  }

  /**
   * Run `userScript`, with the logging functions before it, under real bash.
   * The log file variables are set, as in the app, unless `logFiles` is
   * false. `log` holds what the script wrote to RUNBOOK_LOG, and `levelLogs`
   * what it wrote to the per-level files.
   */
  function runWithLogging(
    userScript: string,
    extraEnv: Record<string, string> = {},
    { logFiles = true }: { logFiles?: boolean } = {},
  ): { stdout: string; stderr: string; exitCode: number; log: string; levelLogs: string } {
    const tmp = makeTmp()
    try {
      const scriptPath = nodePath.join(tmp, "script.sh")
      const logs = logFiles ? makeLogFiles(tmp) : null
      nodeFs.writeFileSync(scriptPath, runnerFor(userScript).script)

      const res = spawnSync("/bin/bash", [scriptPath], {
        encoding: "utf8",
        env: { ...cleanEnv(), ...logs?.env, ...extraEnv },
      })
      return {
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        exitCode: res.status ?? -1,
        ...(logs?.read() ?? { log: "", levelLogs: "" }),
      }
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  /** Prepare `content` and spawn exactly what the executor would, in a fresh scripts dir. */
  async function runPrepared(content: string, scriptPath = "") {
    const tmp = makeTmp()
    try {
      return await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const setup = yield* prepareScript(
              runnerFor(content, { path: scriptPath }, process.platform),
              nodePath.join(tmp, "scripts"),
            )
            const res = yield* Effect.sync(() =>
              spawnSync(setup.command, setup.args, { encoding: "utf8", env: cleanEnv() }),
            )
            return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode: res.status }
          }),
        ).pipe(Effect.provide(NodeFileSystemLive)),
      )
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  it("runs a script as itself, so a shebang's absolute interpreter path is used as written", async () => {
    // Not on PATH, so only the OS reading the shebang finds it
    const tmp = makeTmp()
    try {
      const interpreter = nodePath.join(tmp, "my-interpreter")
      nodeFs.writeFileSync(interpreter, '#!/bin/sh\necho "my-interpreter ran $(basename "$1")"\n')
      nodeFs.chmodSync(interpreter, 0o755)

      const result = await runPrepared(`#!${interpreter}\nignored\n`)

      expect(result).toMatchObject({ exitCode: 0, stdout: "my-interpreter ran script.sh\n" })
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it.skipIf(!Bun.which("python3"))("runs a .py file without a shebang with python3", async () => {
    const result = await runPrepared('print("from python")\n', "checks/verify.py")
    expect(result).toMatchObject({ exitCode: 0, stdout: "from python\n" })
  })

  it("removes the script's directory when the scope closes", async () => {
    const tmp = makeTmp()
    const scriptsDir = nodePath.join(tmp, "scripts")
    try {
      await Effect.runPromise(
        Effect.scoped(prepareScript(runnerFor("echo hi"), scriptsDir)).pipe(
          Effect.provide(NodeFileSystemLive),
        ),
      )
      expect(nodeFs.readdirSync(scriptsDir)).toEqual([])
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("a #!/bin/sh script runs under sh and can call the logging functions", async () => {
    const result = await runPrepared('#!/bin/sh\nset -eu\nlog_info "from sh"\necho done\n')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("done\n")
    expect(result.stderr).toMatch(/\[INFO\]  from sh\n$/)
  })

  it("a script's own EXIT trap runs", async () => {
    const result = await runPrepared(
      "#!/bin/bash\ntrap 'echo cleanup' EXIT\necho running\nexit 3\n",
    )
    expect(result.stdout).toBe("running\ncleanup\n")
    expect(result.exitCode).toBe(3)
  })

  // Log lines start with "[<ISO-8601 zulu timestamp>] ". logLines checks
  // that every line does and drops it, so tests can compare whole lines.
  const LOG_TIMESTAMP = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /
  const logLines = (text: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        expect(line).toMatch(LOG_TIMESTAMP)
        return line.replace(LOG_TIMESTAMP, "")
      })

  it("log_info/warn/error append timestamped lines to RUNBOOK_LOG, never stdout or stderr", () => {
    const result = runWithLogging(
      `set -euo pipefail
       log_info "info-msg"
       log_warn "warn-msg"
       log_error "err-msg"
       log_info two  words`,
    )
    expect(result.exitCode).toBe(0)
    expect(logLines(result.log)).toEqual([
      "[INFO]  info-msg",
      "[WARN]  warn-msg",
      "[ERROR] err-msg",
      "[INFO]  two words",
    ])
    expect(result.levelLogs).toBe("")
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
  })

  it("keeps lines of different levels in the order the script wrote them", () => {
    const result = runWithLogging(
      `log_info "step 1: starting"
       log_error "step 1 failed"
       log_debug "retry count 1"
       log_info "step 2: retrying"
       log_warn "step 2 slow"
       log_info "step 3: done"`,
      { DEBUG: "true" },
    )
    expect(logLines(result.log)).toEqual([
      "[INFO]  step 1: starting",
      "[ERROR] step 1 failed",
      "[DEBUG] retry count 1",
      "[INFO]  step 2: retrying",
      "[WARN]  step 2 slow",
      "[INFO]  step 3: done",
    ])
  })

  it("log_debug is silent when DEBUG is unset", () => {
    const result = runWithLogging(`log_debug "should not appear"`, { DEBUG: "" })
    expect(result.log).toBe("")
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
  })

  it("log_debug logs when DEBUG=true", () => {
    const result = runWithLogging(`log_debug "debug-msg"`, { DEBUG: "true" })
    expect(logLines(result.log)).toEqual(["[DEBUG] debug-msg"])
  })

  // Regression for #269: a function that logs and then prints a value must
  // return only the value through $(...).
  it("log_* calls inside a function don't leak into its $(...) capture", () => {
    const result = runWithLogging(
      `set -euo pipefail
       get_json() {
         log_info "info-msg"
         log_warn "warn-msg"
         log_error "err-msg"
         log_debug "debug-msg"
         echo '{"ok":true}'
       }
       json=$(get_json)
       echo "json=[$json]"`,
      { DEBUG: "true" },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('json=[{"ok":true}]\n')
    expect(result.stderr).toBe("")
    expect(logLines(result.log)).toEqual([
      "[INFO]  info-msg",
      "[WARN]  warn-msg",
      "[ERROR] err-msg",
      "[DEBUG] debug-msg",
    ])
  })

  it("the helpers write to stderr when RUNBOOK_LOG is unset", () => {
    const result = runWithLogging(
      `log_info "info-msg"
       echo out
       log_error "err-msg"`,
      {},
      { logFiles: false },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("out\n")
    expect(logLines(result.stderr)).toEqual(["[INFO]  info-msg", "[ERROR] err-msg"])
  })

  // Once a run ends, Runbooks deletes the log files. A background job that
  // keeps logging must not die on the failed append under an inherited set -e.
  it("the helpers write to stderr when RUNBOOK_LOG can't be written, even under set -e", () => {
    const result = runWithLogging(
      `set -euo pipefail
       log_info "info-msg"
       log_error "err-msg"
       echo "still running"`,
      { RUNBOOK_LOG: "/nonexistent-runbooks-log-dir/runbook.log" },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("still running\n")
    // Only the log lines: the failed redirect's own message is suppressed.
    expect(logLines(result.stderr)).toEqual(["[INFO]  info-msg", "[ERROR] err-msg"])
  })

  it("the logging functions leave the script's stdout and stderr apart", () => {
    const result = runWithLogging(`echo out\necho err >&2`)
    expect(result.stdout).toBe("out\n")
    expect(result.stderr).toBe("err\n")
  })

  // scripts/logging.sh is the copy authors load through BASH_ENV for local
  // development. It must write the same lines as the injected helpers: to
  // RUNBOOK_LOG when it is set, and to stderr when it isn't or can't be
  // written.
  it("scripts/logging.sh writes the same lines as the injected helpers", () => {
    const calls = `set -euo pipefail
       log_info "info 100%s"
       log_warn two words
       log_error "err-msg"
       log_debug "debug-msg"`
    const expected = [
      "[INFO]  info 100%s",
      "[WARN]  two words",
      "[ERROR] err-msg",
      "[DEBUG] debug-msg",
    ]
    const unwritable = { RUNBOOK_LOG: "/nonexistent-runbooks-log-dir/runbook.log" }
    const loggingSh = nodePath.resolve(import.meta.dirname, "../../../scripts/logging.sh")
    const tmp = makeTmp()
    try {
      const logFiles = makeLogFiles(tmp)
      const runLocal = (env: Record<string, string>) =>
        spawnSync("/bin/bash", ["-c", `source "$1"\n${calls}`, "_", loggingSh], {
          encoding: "utf8",
          env: { ...cleanEnv(), DEBUG: "true", ...env },
        })

      const local = runLocal(logFiles.env)
      const injected = runWithLogging(calls, { DEBUG: "true" })
      expect(local.status).toBe(0)
      expect(local.stdout).toBe("")
      expect(local.stderr).toBe("")
      const localLogs = logFiles.read()
      expect(logLines(localLogs.log)).toEqual(expected)
      expect(localLogs.levelLogs).toBe("")
      expect(logLines(injected.log)).toEqual(expected)

      for (const env of [{}, unwritable]) {
        const outside = runLocal(env)
        const injectedOutside = runWithLogging(
          calls,
          { DEBUG: "true", ...env },
          { logFiles: false },
        )
        expect(outside.status).toBe(0)
        expect(outside.stdout).toBe("")
        expect(logLines(outside.stderr)).toEqual(expected)
        expect(injectedOutside.exitCode).toBe(0)
        expect(logLines(injectedOutside.stderr)).toEqual(expected)
      }
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
