/**
 * Test execution engine.
 *
 * Runs runbook tests in headless mode: parses the MDX, executes blocks in
 * document order (or in the order a test's steps list them), captures
 * outputs, and validates assertions.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync, execFileSync } from "node:child_process"
import { ManagedRuntime } from "effect"

import { extractProp } from "../../src/domain/registry/executable.ts"
import { ExecutableRegistry } from "../../src/domain/registry/executable.ts"
import { NodeFileSystemLive } from "../../src/layers/NodeFileSystem.ts"
import {
  detectInterpreter,
  isBashInterpreter,
  parseBlockOutputsContent,
  parseEnvCaptureContent,
  wrapBashScript,
} from "../../src/domain/exec/script.ts"
import { filterCapturedEnv } from "../../src/domain/session/manager.ts"
import { injectTokenIntoUrl } from "../../src/domain/git/url.ts"
import { parseOwnerRepoFromURL } from "../../src/domain/git/operations.ts"
import { normalizeGitLabHost } from "../../src/domain/git/gitlab-host.ts"
import {
  GITLAB_TOKEN_ENV_VARS,
  envTokenHost,
  mayAutoSendEnvToken,
} from "../../src/domain/gitlab/auth.ts"
import { redactSecrets } from "../../src/domain/vcs/redact.ts"
import type { Executable } from "../../src/types.ts"

import type {
  TestCase,
  TestStep,
  ExpectedStatus,
  TestResult,
  StepResult,
} from "./config.ts"
import { resolveTestInputs } from "./fuzz.ts"
import {
  runAssertion,
  countFiles,
  envListToRecord,
  type AssertionContext,
} from "./assertions.ts"
import {
  InputValidator,
  parseAuthDependencies,
  parseTemplateInlineBlocks,
  parseTemplateBlocks,
  lowercaseFirst,
  type TemplateInlineBlock,
  type TemplateBlock,
  type AuthDependency,
} from "./validation.ts"
import { AUTH_BLOCK_TYPES, PR_BLOCK_TYPES } from "./blockTypes.ts"
import type { ParsedComponent } from "../../src/domain/registry/executable.ts"

// ---------------------------------------------------------------------------
// Block types & states
// ---------------------------------------------------------------------------

type BlockState = "success" | "skipped"

type GitProvider = "github" | "gitlab"

const AUTH_BLOCK_SET = new Set<string>(AUTH_BLOCK_TYPES)
const PR_BLOCK_SET = new Set<string>(PR_BLOCK_TYPES)

function isAuthBlock(blockType: string): boolean {
  return AUTH_BLOCK_SET.has(blockType)
}

// ---------------------------------------------------------------------------
// Google Cloud credential environment variables
// ---------------------------------------------------------------------------
//
// These mirror src/domain/google/auth.ts, which is what <GoogleAuth> uses to
// detect ambient credentials in the app. Keep the two in sync.

/**
 * Credential-bearing vars in detection precedence order: a path to a
 * credentials JSON, an inline credentials JSON, then a bare OAuth access token.
 * A path may hold EITHER a service-account key or an authorized_user document —
 * headless test mode never opens it, so the distinction does not matter here.
 */
const GOOGLE_CREDENTIAL_ENV_VARS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CREDENTIALS",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
] as const

/** Project vars read during detection, in precedence order. */
const GOOGLE_PROJECT_ENV_VARS = [
  "CLOUDSDK_CORE_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_PROJECT",
  "GCLOUD_PROJECT",
] as const

/** Compute-region vars read during detection, in precedence order. */
const GOOGLE_REGION_ENV_VARS = ["CLOUDSDK_COMPUTE_REGION", "GOOGLE_CLOUD_REGION"] as const

/** Compute-zone vars read during detection. */
const GOOGLE_ZONE_ENV_VARS = ["CLOUDSDK_COMPUTE_ZONE"] as const

/**
 * Vars written on success. Each family is written in full — client libraries,
 * the gcloud CLI, and the OpenTofu `google` provider each read a different
 * name, and the app's session env writes all of them for exactly that reason.
 */
const GOOGLE_PROJECT_WRITE_VARS = [
  "GOOGLE_CLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "GOOGLE_PROJECT",
] as const
const GOOGLE_REGION_WRITE_VARS = [
  "GOOGLE_CLOUD_REGION",
  "CLOUDSDK_COMPUTE_REGION",
  "GOOGLE_REGION",
] as const
const GOOGLE_ZONE_WRITE_VARS = ["CLOUDSDK_COMPUTE_ZONE", "GOOGLE_ZONE"] as const

/**
 * A git auth block's env lookup: the token and the session vars to write, or
 * why the block skips.
 */
type GitAuthLookup =
  | { token: string; vars: Record<string, string> }
  | { skipReason: string }

/** Build a StepResult with its mutable fields freshly initialized per call. */
function makeStepResult(
  block: string,
  expectedStatus: ExpectedStatus,
): StepResult {
  return {
    block,
    expectedStatus,
    actualStatus: "",
    exitCode: 0,
    passed: true,
    outputs: {},
    duration: 0,
    assertionResults: [],
  }
}

// ---------------------------------------------------------------------------
// Go template renderer (simple subset for runbook scripts/templates)
// ---------------------------------------------------------------------------

/**
 * Render a Go text/template-compatible string with the given variables.
 * Supports: {{ .path.to.value }} and {{ if .x }}...{{ else }}...{{ end }}.
 * This is a simplified renderer covering patterns used in runbook tests.
 */
function renderGoTemplate(
  content: string,
  vars: Record<string, unknown>,
): string {
  // Handle {{ if .x }}...{{ else }}...{{ end }}
  let result = content.replace(
    /\{\{\s*if\s+\.([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)(?:\{\{\s*else\s*\}\}([\s\S]*?))?\{\{\s*end\s*\}\}/g,
    (_match, keyPath: string, truePart: string, falsePart?: string) => {
      const value = resolveDotPath(vars, keyPath)
      if (value) return truePart
      return falsePart ?? ""
    },
  )

  // Handle {{ .path.to.value }} variable substitution
  result = result.replace(
    /\{\{\s*\.([a-zA-Z0-9_.]+)\s*\}\}/g,
    (_match, keyPath: string) => {
      const value = resolveDotPath(vars, keyPath)
      if (value === undefined || value === null) {
        throw new Error(`Template references {{.${keyPath}}} but that variable is not defined`)
      }
      return String(value)
    },
  )

  // Handle {{ fromJson .path.to.value }} (returns parsed JSON)
  result = result.replace(
    /\{\{\s*fromJson\s+\.([a-zA-Z0-9_.]+)\s*\}\}/g,
    (_match, keyPath: string) => {
      const value = resolveDotPath(vars, keyPath)
      if (value === undefined) return ""
      try {
        return JSON.stringify(JSON.parse(String(value)))
      } catch {
        return String(value)
      }
    },
  )

  return result
}

function resolveDotPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".")
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

// ---------------------------------------------------------------------------
// Executor options
// ---------------------------------------------------------------------------

export interface ExecutorOptions {
  timeout: number
  verbose: boolean
}

// ---------------------------------------------------------------------------
// TestExecutor
// ---------------------------------------------------------------------------

export class TestExecutor {
  private registry!: ExecutableRegistry
  private validator!: InputValidator
  private templateInlines!: Map<string, TemplateInlineBlock>
  private templates!: Map<string, TemplateBlock>
  private authDeps!: Map<string, AuthDependency>

  // process.env as captured by init(); every test starts from a copy
  private initialSessionEnv: string[] = []

  // Per-test state (reset each test)
  private workingDir: string
  private sessionEnv: string[] = []
  private sessionWorkDir: string
  private blockOutputs = new Map<string, Map<string, string>>()
  // Files each block wrote this test case, by block ID, for files_generated
  private generatedFileCounts = new Map<string, number>()
  private testInputs: Record<string, unknown> = {}
  private testEnv: Record<string, string> = {}
  private blockStates = new Map<string, BlockState>()
  private authBlockCredentials = new Map<string, Record<string, string>>()
  // The token each git auth block found, and for which provider, for GitClone
  private gitAuthTokens = new Map<string, { provider: GitProvider; token: string }>()
  private activeWorkTreePath = ""

  /**
   * `defaultWorkingDir` is where a test case runs when runTest isn't given a
   * working directory of its own.
   */
  constructor(
    private runbookPath: string,
    private defaultWorkingDir: string,
    private outputPath: string,
    private options: ExecutorOptions,
  ) {
    this.workingDir = defaultWorkingDir
    this.sessionWorkDir = defaultWorkingDir
  }

  /** Initialize the executor: parse runbook, build registry, validate config. */
  async init(): Promise<void> {
    // Build executable registry using Effect + FileSystem service
    const runtime = ManagedRuntime.make(NodeFileSystemLive)
    try {
      this.registry = await runtime.runPromise(
        ExecutableRegistry.create(this.runbookPath),
      )
    } finally {
      await runtime.dispose()
    }

    // Build validator
    this.validator = new InputValidator(this.runbookPath)
    this.validator.init()

    // Parse template blocks
    this.templateInlines = parseTemplateInlineBlocks(this.runbookPath)
    this.templates = parseTemplateBlocks(this.runbookPath)

    // Parse auth dependencies
    this.authDeps = parseAuthDependencies(this.runbookPath)

    // Capture initial environment
    this.initialSessionEnv = Object.entries(process.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
  }

  // -----------------------------------------------------------------------
  // Verbose output helpers
  // -----------------------------------------------------------------------

  printRunbookHeader(): void {
    if (!this.options.verbose) return
    const relPath = path.relative(process.cwd(), this.runbookPath) || this.runbookPath
    console.log()
    console.log("╔══════════════════════════════════════════════════════════════════════════════")
    console.log(`║ RUNBOOK: ${relPath}`)
    console.log("╚══════════════════════════════════════════════════════════════════════════════")
  }

  printTestHeader(testName: string): void {
    if (!this.options.verbose) return
    console.log(`\n── Test: ${testName} ──`)
  }

  // -----------------------------------------------------------------------
  // Path helpers
  // -----------------------------------------------------------------------

  private resolveOutputPath(): string {
    return path.join(this.workingDir, this.outputPath)
  }

  private getenv(key: string): string {
    if (this.testEnv[key] !== undefined) return this.testEnv[key]
    return process.env[key] ?? ""
  }

  /** True when `key` is present in the environment, even when it is set to "". */
  private hasEnv(key: string): boolean {
    return this.testEnv[key] !== undefined || process.env[key] !== undefined
  }

  /** First non-empty value among `${prefix}${name}`, in the order listed. */
  private firstEnv(prefix: string, names: readonly string[]): string {
    for (const name of names) {
      const value = this.getenv(`${prefix}${name}`)
      if (value) return value
    }
    return ""
  }

  // -----------------------------------------------------------------------
  // Run a test case
  // -----------------------------------------------------------------------

  /**
   * Run one test case. Each test case starts clean: block outputs, the session
   * env and the cwd start over, so nothing an earlier test case exported,
   * cd'd into or authenticated carries into this one. With
   * use_temp_working_dir, runTestSuite also passes a fresh `workingDir` per
   * test case, so files and clones don't carry over either.
   */
  runTest(tc: TestCase, workingDir = this.defaultWorkingDir): TestResult {
    const start = Date.now()
    const result: TestResult = {
      testCase: tc.name,
      status: "passed",
      duration: 0,
      stepResults: [],
      assertions: [],
    }

    // 0. Check for unknown component errors
    for (const err of this.validator.getConfigErrors()) {
      if (err.componentId === "(unknown)") {
        result.status = "failed"
        result.error = `<${err.componentType}>: ${err.message}`
        result.duration = Date.now() - start
        return result
      }
    }

    // 1. Resolve test inputs (fuzz + literal)
    let resolvedInputs: Record<string, unknown>
    try {
      resolvedInputs = resolveTestInputs(tc.inputs)
    } catch (e: unknown) {
      result.status = "failed"
      result.error = `Failed to resolve test config: ${e}`
      result.duration = Date.now() - start
      return result
    }

    // Backfill defaults from Inputs block schemas
    for (const [inputsId, schema] of this.validator.getAllSchemas()) {
      for (const [varName, variable] of schema.variables) {
        const key = `${inputsId}.${varName}`
        if (!(key in resolvedInputs) && variable.default !== undefined) {
          resolvedInputs[key] = variable.default
        }
      }
    }

    // 2. Validate inputs against schemas
    const validationErrors = this.validator.validateInputValues(resolvedInputs)
    if (validationErrors.length > 0) {
      result.status = "failed"
      result.error = "Input validation failed:\n" +
        validationErrors.map((e) => `  - ${e.inputKey}: ${e.message}`).join("\n")
      result.duration = Date.now() - start
      return result
    }

    // Print resolved inputs in verbose mode
    if (this.options.verbose && Object.keys(resolvedInputs).length > 0) {
      console.log("\n--- Test Inputs ---")
      for (const k of Object.keys(resolvedInputs).sort()) {
        let display = String(resolvedInputs[k])
        if (display.length > 80) display = display.slice(0, 77) + "..."
        console.log(`  ${k} = ${display}`)
      }
    }

    this.testInputs = resolvedInputs
    this.testEnv = tc.env ?? {}
    this.workingDir = workingDir
    this.sessionEnv = [...this.initialSessionEnv]
    this.sessionWorkDir = workingDir
    this.blockOutputs = new Map()
    this.generatedFileCounts = new Map()
    this.blockStates = new Map()
    this.authBlockCredentials = new Map()
    this.gitAuthTokens = new Map()
    this.activeWorkTreePath = ""

    // 3. Get all blocks in document order
    const allBlocks = this.validator.getComponents()

    // 4. Pair each block to run with its step. Explicit steps run in the order
    // listed, so a block can run more than once with a different expectation
    // each time; without steps, every block runs once in document order,
    // expected to succeed, except PR blocks, which never run in test mode.
    const plan: Array<{ block: ParsedComponent; step: TestStep }> = []
    if (tc.steps && tc.steps.length > 0) {
      for (const [i, step] of tc.steps.entries()) {
        const block = allBlocks.find((b) => b.id === step.block)
        if (!block) {
          result.status = "failed"
          result.error = `Test step ${i + 1} references unknown block "${step.block}"`
          result.duration = Date.now() - start
          return result
        }
        plan.push({ block, step })
      }
    } else {
      for (const block of allBlocks) {
        const expect = PR_BLOCK_SET.has(block.type) ? "skip" : "success"
        plan.push({ block, step: { block: block.id, expect } })
      }
    }

    const registryWarnings = this.registry.getWarnings()

    // Cleanup runs however the test ends (a failed block or assertion, or an
    // unexpected throw) so teardown is never skipped.
    try {
      // 5. Process each planned step
      for (const { block, step } of plan) {
        const stepResult = this.processBlock(block, step, registryWarnings)
        result.stepResults.push(stepResult)

        if (!stepResult.passed) {
          result.status = "failed"
          result.error = this.formatBlockError(block, stepResult)
          break
        }

        // Per-step assertions
        if (step.assertions) {
          for (const assertion of step.assertions) {
            const ar = runAssertion(assertion, this.makeAssertionCtx())
            stepResult.assertionResults.push(ar)
            if (!ar.passed) {
              result.status = "failed"
              result.error = `${block.type} block "${block.id}" assertion failed: ${ar.message}`
              break
            }
          }
          if (result.status === "failed") break
        }
      }

      // Post-test assertions
      if (result.status !== "failed" && tc.assertions) {
        for (const assertion of tc.assertions) {
          const ar = runAssertion(assertion, this.makeAssertionCtx())
          result.assertions.push(ar)
          if (!ar.passed) {
            result.status = "failed"
            result.error = `Assertion failed: ${ar.message}`
            break
          }
        }
      }
    } finally {
      if (tc.cleanup) {
        for (const cleanup of tc.cleanup) {
          this.runCleanup(cleanup)
        }
      }
    }

    result.duration = Date.now() - start
    return result
  }

  // -----------------------------------------------------------------------
  // Block processing
  // -----------------------------------------------------------------------

  private processBlock(
    block: ParsedComponent,
    step: TestStep,
    registryWarnings: string[],
  ): StepResult {
    const start = Date.now()

    const result = makeStepResult(
      `${lowercaseFirst(block.type)}:${block.id}`,
      step.expect,
    )

    // 1. Check for config errors
    const configError = this.getConfigErrorForBlock(block, registryWarnings)

    if (configError) {
      result.actualStatus = "config_error"
      result.error = configError

      if (step.expect === "config_error") {
        if (step.error_contains && !configError.toLowerCase().includes(step.error_contains.toLowerCase())) {
          result.passed = false
        } else {
          result.passed = true
        }
      } else {
        result.passed = false
      }

      if (this.options.verbose) {
        console.log(`\n=== ${block.type}: ${block.id} ===`)
        console.log(`--- Config: ${result.passed ? "✓" : "✗"} ${result.actualStatus} ---`)
        console.log(`  Error: ${configError}`)
        result.errorDisplayed = true
      }

      result.duration = Date.now() - start
      return result
    }

    // 2. Inputs blocks: validation-only
    if (block.type === "Inputs") {
      result.actualStatus = "valid"
      result.passed = true
      if (this.options.verbose) {
        console.log(`\n=== ${block.type}: ${block.id} ===`)
        console.log("--- Config: ✓ valid ---")
      }
      result.duration = Date.now() - start
      return result
    }

    // 3. Check auth dependencies. A block whose auth block hasn't run, or was
    // skipped, is blocked, which is what an `expect: blocked` step asserts.
    if (this.authDeps.has(block.id)) {
      const authDep = this.authDeps.get(block.id)!
      const authState = this.blockStates.get(authDep.authBlockId)

      if (authState === undefined) {
        result.passed = step.expect === "blocked"
        result.actualStatus = "blocked"
        result.error = `Block depends on "${authDep.authBlockId}" which hasn't run yet`
        result.duration = Date.now() - start
        return result
      }

      if (authState === "skipped") {
        if (step.expect === "skip") {
          result.passed = true
          result.actualStatus = "skipped"
          result.duration = Date.now() - start
          return result
        }
        result.passed = step.expect === "blocked"
        result.actualStatus = "blocked"
        result.error = `Block depends on "${authDep.authBlockId}" which was skipped`
        result.duration = Date.now() - start
        return result
      }
    }

    // 4. Dispatch block
    return this.dispatchBlock(block, step, start)
  }

  private getConfigErrorForBlock(block: ParsedComponent, registryWarnings: string[]): string {
    if (block.type === "Check" || block.type === "Command") {
      const warning = registryWarnings.find((w) => w.includes(`id="${block.id}"`))
      if (warning) return warning
    }
    return this.validator.getConfigError(block.type, block.id)
  }

  // -----------------------------------------------------------------------
  // Block dispatch
  // -----------------------------------------------------------------------

  private dispatchBlock(
    block: ParsedComponent,
    step: TestStep,
    start: number,
  ): StepResult {
    const result = makeStepResult(
      `${lowercaseFirst(block.type)}:${block.id}`,
      step.expect,
    )

    if (this.options.verbose) {
      console.log(`\n=== ${block.type}: ${block.id} ===`)
    }

    // Handle skip expectation
    if (step.expect === "skip") {
      result.passed = true
      result.actualStatus = "skipped"
      result.duration = Date.now() - start
      if (isAuthBlock(block.type)) this.blockStates.set(block.id, "skipped")
      if (this.options.verbose) console.log("  (skipped)")
      return result
    }

    // Handle config_error expectation but no config error found
    if (step.expect === "config_error") {
      result.passed = false
      result.actualStatus = "no_config_error"
      result.error = "Expected config_error but block configuration is valid"
      result.duration = Date.now() - start
      return result
    }

    // Handle blocked expectation before rendering anything: a blocked block's
    // templates reference outputs that don't exist yet, so rendering would fail.
    if (step.expect === "blocked") {
      const missing = this.checkMissingOutputs(step.missing_outputs ?? [])
      if (missing.length > 0) {
        result.passed = true; result.actualStatus = "blocked"
        result.error = `Blocked due to missing outputs: ${missing.join(", ")}`
      } else {
        result.passed = false; result.actualStatus = "not_blocked"
        result.error = "Expected block to be blocked but all dependencies are satisfied"
      }
      result.duration = Date.now() - start
      return result
    }

    // Render template vars in block props if needed
    if (block.props.includes("{{")) {
      try {
        block = { ...block, props: renderGoTemplate(block.props, this.buildTemplateVars()) }
      } catch (e: unknown) {
        result.passed = false
        result.actualStatus = "error"
        result.error = `Failed to render template in block props: ${e}`
        result.duration = Date.now() - start
        return result
      }
    }

    switch (block.type) {
      case "TemplateInline": {
        const tmpl = this.templateInlines.get(block.id)
        if (!tmpl) {
          result.passed = false; result.actualStatus = "error"
          result.error = `TemplateInline block "${block.id}" not found`
          result.duration = Date.now() - start
          return result
        }
        return this.runTemplateInline(step, tmpl, start)
      }

      case "Template": {
        const tmpl = this.templates.get(block.id)
        if (!tmpl) {
          result.passed = false; result.actualStatus = "error"
          result.error = `Template block "${block.id}" not found`
          result.duration = Date.now() - start
          return result
        }
        return this.runTemplate(step, tmpl, start)
      }

      case "Check":
      case "Command":
        return this.runCheckOrCommand(block, step, start)

      case "GitHubAuth":
        return this.runGitAuth(block, step, start, "github")

      case "GitLabAuth":
        return this.runGitAuth(block, step, start, "gitlab")

      case "GitAuth": {
        const provider = extractProp(block.props, "provider") || "github"
        if (provider !== "github" && provider !== "gitlab") {
          result.passed = false; result.actualStatus = "error"
          result.error = `Unsupported provider "${provider}" (expected "github" or "gitlab")`
          result.duration = Date.now() - start
          return result
        }
        return this.runGitAuth(block, step, start, provider)
      }

      case "AwsAuth":
        return this.runAwsAuth(block, step, start)

      case "GoogleAuth":
        return this.runGoogleAuth(block, step, start)

      case "GitClone":
        return this.runGitClone(block, step, start)

      // `expect: skip` returned above, so any expectation that gets here would
      // need the block to push a branch and open a real pull request.
      case "GitPullRequest":
      case "GitHubPullRequest":
      case "GitLabMergeRequest":
        result.passed = false; result.actualStatus = "error"
        result.error = "PR blocks can only be tested with expect: skip (test mode never opens a pull request)"
        result.duration = Date.now() - start
        return result

      default:
        result.passed = false; result.actualStatus = "error"
        result.error = `Unsupported block type "${block.type}"`
        result.duration = Date.now() - start
        return result
    }
  }

  // -----------------------------------------------------------------------
  // Check / Command block
  // -----------------------------------------------------------------------

  private runCheckOrCommand(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(
      `${lowercaseFirst(block.type)}:${block.id}`,
      step.expect,
    )

    // Find the executable by component ID
    let foundExec: Executable | undefined
    const allExecs = this.registry.getAllExecutables()
    for (const id of Object.keys(allExecs)) {
      const entry = allExecs[id]
      if (entry.componentId === block.id) {
        foundExec = this.registry.getExecutableSync(id)
        break
      }
    }

    if (!foundExec) {
      result.passed = false; result.actualStatus = "error"
      result.error = `Block "${block.id}" not found in runbook`
      result.duration = Date.now() - start
      return result
    }

    // Render template vars in script content
    let scriptContent = foundExec.content
    try {
      scriptContent = renderGoTemplate(scriptContent, this.buildTemplateVars())
    } catch (e: unknown) {
      result.passed = false; result.actualStatus = "error"
      result.error = `Failed to render template: ${e}`
      result.duration = Date.now() - start
      return result
    }

    // Create temp files for outputs and file capture
    const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runbook-output-")), "output.txt")
    fs.writeFileSync(outputFile, "")
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-files-"))
    // Made below; declared here so the finally can remove them
    let envDir = ""
    let pwdDir = ""
    let scriptDir = ""

    try {
      // Prepare the script
      const [interpreter, interpreterArgs] = detectInterpreter(scriptContent, foundExec.language)
      const isBash = isBashInterpreter(interpreter)

      let scriptToWrite = scriptContent
      let envCapturePath = ""
      let pwdCapturePath = ""

      if (isBash) {
        envDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-env-"))
        envCapturePath = path.join(envDir, "env.txt")
        fs.writeFileSync(envCapturePath, "")
        pwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-pwd-"))
        pwdCapturePath = path.join(pwdDir, "pwd.txt")
        fs.writeFileSync(pwdCapturePath, "")
        scriptToWrite = wrapBashScript(scriptContent, envCapturePath, pwdCapturePath)
      }

      scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-script-"))
      const scriptPath = path.join(scriptDir, "script.sh")
      fs.writeFileSync(scriptPath, scriptToWrite, { mode: 0o700 })

      // Build environment
      const env = envListToRecord(this.sessionEnv)
      env["RUNBOOK_OUTPUT"] = outputFile
      env["GENERATED_FILES"] = filesDir
      if (this.activeWorkTreePath) env["REPO_FILES"] = this.activeWorkTreePath

      // Add test env vars
      for (const [k, v] of Object.entries(this.testEnv)) {
        env[k] = v
      }

      // Inject auth block credentials if this block has an auth dependency
      if (this.authDeps.has(foundExec.componentId)) {
        const authDep = this.authDeps.get(foundExec.componentId)!
        const creds = this.authBlockCredentials.get(authDep.authBlockId)
        if (creds) {
          for (const [k, v] of Object.entries(creds)) {
            env[k] = v
          }
        }
      }

      // Run the script
      const args = [...interpreterArgs, scriptPath]
      const proc = spawnSync(interpreter, args, {
        cwd: this.sessionWorkDir,
        env,
        timeout: this.options.timeout,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      })

      const logs = (proc.stdout?.toString() ?? "") + (proc.stderr?.toString() ?? "")
      const exitCode = proc.status ?? -1
      let status: string

      if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        status = "timeout"
        result.error = "Script timed out"
      } else if (exitCode === 0) {
        status = "success"
      } else if (exitCode === 2) {
        status = "warn"
      } else {
        status = "fail"
      }

      result.actualStatus = status
      result.exitCode = exitCode
      result.logs = logs

      // Parse outputs
      if (status === "success" || status === "warn") {
        try {
          result.outputs = parseBlockOutputsContent(fs.readFileSync(outputFile, "utf-8"))
        } catch { /* no outputs */ }

        // Carry the script's exports and final cwd into later blocks
        if (isBash) this.applyEnvCapture(envCapturePath, pwdCapturePath)

        // Copy captured files to output directory
        this.creditGeneratedFiles(block.id, this.captureFiles(filesDir, this.resolveOutputPath()))
      }

      if (this.options.verbose) {
        this.printBlockOutput(block.id, logs, result.outputs, status, result.error)
      }

      // Store outputs
      if (Object.keys(result.outputs).length > 0) {
        const map = new Map<string, string>()
        for (const [k, v] of Object.entries(result.outputs)) map.set(k, v)
        this.blockOutputs.set(block.id, map)
      }

      result.passed = this.matchesExpectedStatus(step.expect, status)
      result.duration = Date.now() - start
      return result

    } finally {
      // Cleanup temp files. The env capture holds every variable the script
      // saw, credentials included, so it must not outlive the block.
      for (const dir of [path.dirname(outputFile), filesDir, envDir, pwdDir, scriptDir]) {
        if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
      }
    }
  }

  /**
   * Apply a bash block's env/pwd capture the way the app's session does after
   * a successful run: the captured env, minus shell internals and per-block
   * vars like RUNBOOK_OUTPUT, replaces the session env, and a non-empty pwd
   * becomes the cwd for later blocks.
   */
  private applyEnvCapture(envCapturePath: string, pwdCapturePath: string): void {
    let env: Record<string, string> | undefined
    try {
      env = parseEnvCaptureContent(fs.readFileSync(envCapturePath, "utf-8"))
    } catch { /* nothing captured */ }
    if (!env) return

    this.sessionEnv = Object.entries(filterCapturedEnv(env)).map(([k, v]) => `${k}=${v}`)

    let pwd = ""
    try {
      pwd = fs.readFileSync(pwdCapturePath, "utf-8").trim()
    } catch { /* keep the current cwd */ }
    if (pwd) this.sessionWorkDir = pwd
  }

  // -----------------------------------------------------------------------
  // TemplateInline block
  // -----------------------------------------------------------------------

  private runTemplateInline(step: TestStep, block: TemplateInlineBlock, start: number): StepResult {
    const result = makeStepResult(step.block, step.expect)

    // Render the template
    let rendered: string
    try {
      rendered = renderGoTemplate(block.content, this.buildTemplateVars())
    } catch (e: unknown) {
      result.passed = false; result.actualStatus = "error"
      result.error = `${e}`
      result.duration = Date.now() - start
      return result
    }

    // Write file if generateFile is set
    if (block.generateFile && block.outputPath) {
      let outputDir: string
      if (block.target === "worktree") {
        if (!this.activeWorkTreePath) {
          result.passed = false; result.actualStatus = "error"
          result.error = 'Target is "worktree" but no git worktree has been cloned'
          result.duration = Date.now() - start
          return result
        }
        outputDir = this.activeWorkTreePath
      } else {
        outputDir = this.resolveOutputPath()
      }

      const outputFile = path.join(outputDir, block.outputPath)
      try {
        fs.mkdirSync(path.dirname(outputFile), { recursive: true })
        fs.writeFileSync(outputFile, rendered)
        this.creditGeneratedFiles(block.id, 1)
        if (this.options.verbose) console.log(`--- Wrote file: ${outputFile} ---`)
      } catch (e: unknown) {
        result.passed = false; result.actualStatus = "error"
        result.error = `Failed to write file: ${e}`
        result.duration = Date.now() - start
        return result
      }
    }

    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.actualStatus = "success"
    result.logs = rendered
    result.duration = Date.now() - start

    if (this.options.verbose) {
      console.log("--- Rendered Output ---")
      const lines = rendered.split("\n")
      for (let i = 0; i < Math.min(lines.length, 20); i++) {
        console.log(`  ${lines[i]}`)
      }
      if (lines.length > 20) console.log(`  ... (${lines.length - 20} more lines)`)
      console.log("--- Result: ✓ success ---")
    }

    return result
  }

  // -----------------------------------------------------------------------
  // Template block
  // -----------------------------------------------------------------------

  private runTemplate(step: TestStep, block: TemplateBlock, start: number): StepResult {
    const result = makeStepResult(step.block, step.expect)

    const runbookDir = path.dirname(this.runbookPath)
    const templatePath = path.join(runbookDir, block.templatePath)

    let outputDir: string
    if (block.target === "worktree") {
      if (!this.activeWorkTreePath) {
        result.passed = false; result.actualStatus = "error"
        result.error = 'Target is "worktree" but no git worktree has been cloned'
        result.duration = Date.now() - start
        return result
      }
      outputDir = this.activeWorkTreePath
    } else {
      outputDir = this.resolveOutputPath()
    }

    fs.mkdirSync(outputDir, { recursive: true })

    // Template rendering requires the boilerplate WASM binary.
    // For now, we attempt a simple file-copy-with-substitution approach.
    try {
      const vars = this.buildTemplateVars()
      // Template blocks expect variables at top level ({{ .config_name }}),
      // not nested under inputs ({{ .inputs.config_name }}).
      // Merge this block's inputs into the top level of vars.
      for (const [key, value] of Object.entries(this.testInputs)) {
        const parts = key.split(".", 2)
        if (parts.length === 2 && parts[0] === block.id) {
          vars[parts[1]] = value
        }
      }
      this.creditGeneratedFiles(block.id, this.renderTemplateDir(templatePath, outputDir, vars))
    } catch (e: unknown) {
      result.passed = false; result.actualStatus = "error"
      result.error = `Template rendering failed: ${e}`
      result.duration = Date.now() - start
      return result
    }

    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.actualStatus = "success"
    result.duration = Date.now() - start

    if (this.options.verbose) {
      console.log("--- Result: ✓ success ---")
    }

    return result
  }

  /**
   * Walk a template directory, render each file through Go template, and write
   * to the output directory. Skips `boilerplate.yml` and hidden files. Returns
   * the number of files written.
   */
  private renderTemplateDir(
    templateDir: string,
    outputDir: string,
    vars: Record<string, unknown>,
  ): number {
    let written = 0
    const entries = fs.readdirSync(templateDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === "boilerplate.yml" || entry.name.startsWith(".")) continue

      const srcPath = path.join(templateDir, entry.name)
      const destPath = path.join(outputDir, entry.name)

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true })
        written += this.renderTemplateDir(srcPath, destPath, vars)
      } else {
        const content = fs.readFileSync(srcPath, "utf-8")
        const rendered = renderGoTemplate(content, vars)
        fs.writeFileSync(destPath, rendered)
        written++
      }
    }
    return written
  }

  // -----------------------------------------------------------------------
  // GitHubAuth / GitLabAuth / GitAuth blocks
  // -----------------------------------------------------------------------

  /**
   * Git auth in headless test mode, for either provider: find a token in the
   * provider's env vars and write the session vars main writes on a
   * successful auth (GITHUB_TOKEN, or GITLAB_TOKEN and GITLAB_HOST). Like the
   * other auth runners this never reaches the network, so the token is taken
   * at face value.
   */
  private runGitAuth(
    block: ParsedComponent,
    step: TestStep,
    start: number,
    provider: GitProvider,
  ): StepResult {
    const result = makeStepResult(`${lowercaseFirst(block.type)}:${block.id}`, step.expect)
    const providerName = provider === "gitlab" ? "GitLab" : "GitHub"

    const prefix = step.env_prefix ?? ""
    const lookup = provider === "gitlab"
      ? this.findGitLabAuthEnv(block, prefix)
      : this.findGitHubAuthEnv(prefix)

    if ("skipReason" in lookup) {
      this.blockStates.set(block.id, "skipped")
      result.actualStatus = "skipped"
      result.passed = this.matchesExpectedStatus(step.expect, "skipped")
      result.duration = Date.now() - start
      if (this.options.verbose) console.log(`--- ${lookup.skipReason} ---`)
      return result
    }

    const envVars = lookup.vars
    this.authBlockCredentials.set(block.id, envVars)
    this.gitAuthTokens.set(block.id, { provider, token: lookup.token })

    // Inject into session env
    const written = new Set(Object.keys(envVars))
    this.sessionEnv = this.sessionEnv.filter((entry) => {
      const eq = entry.indexOf("=")
      return eq === -1 || !written.has(entry.slice(0, eq))
    })
    for (const [k, v] of Object.entries(envVars)) {
      this.sessionEnv.push(`${k}=${v}`)
    }

    this.blockStates.set(block.id, "success")
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.duration = Date.now() - start
    if (this.options.verbose) console.log(`--- ${providerName} credentials found, injected ---`)
    return result
  }

  private findGitHubAuthEnv(prefix: string): GitAuthLookup {
    const token = prefix
      ? this.getenv(`${prefix}GITHUB_TOKEN`) || this.getenv(`${prefix}GH_TOKEN`)
      : this.getenv("RUNBOOKS_GITHUB_TOKEN") || this.getenv("GITHUB_TOKEN") || this.getenv("GH_TOKEN")
    if (!token) return { skipReason: "No GitHub credentials found" }
    return { token, vars: { GITHUB_TOKEN: token } }
  }

  /**
   * GitLab token lookup, with the app's env-token host binding: an env token
   * belongs to the one host GITLAB_HOST (or GITLAB_URI, GL_HOST) names,
   * gitlab.com by default, so a block pinned to another host with
   * `instanceUrl` or `host` doesn't get it.
   */
  private findGitLabAuthEnv(block: ParsedComponent, prefix: string): GitAuthLookup {
    const token = this.firstEnv(prefix, GITLAB_TOKEN_ENV_VARS)
    if (!token) return { skipReason: "No GitLab credentials found" }

    const env: Record<string, string | undefined> = { ...process.env, ...this.testEnv }
    const pinned = extractProp(block.props, "instanceUrl") || extractProp(block.props, "host")
    const host = pinned ? normalizeGitLabHost(pinned) : envTokenHost(env)
    if (!host || !mayAutoSendEnvToken(host, env)) {
      const bound = envTokenHost(env)
      return {
        skipReason: bound
          ? `GitLab token is for ${bound}, not ${host}; set GITLAB_HOST to use it there`
          : "GitLab token has no usable host: GITLAB_HOST (or GITLAB_URI, GL_HOST) isn't a valid URL or host",
      }
    }
    return { token, vars: { GITLAB_TOKEN: token, GITLAB_HOST: host } }
  }

  // -----------------------------------------------------------------------
  // AwsAuth block
  // -----------------------------------------------------------------------

  private runAwsAuth(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`awsAuth:${block.id}`, step.expect)

    const prefix = step.env_prefix ?? ""
    const blockCreds: Record<string, string> = {}
    let found = false

    // Check explicit env var credentials
    const accessKey = this.getenv(`${prefix}AWS_ACCESS_KEY_ID`)
    const secretKey = this.getenv(`${prefix}AWS_SECRET_ACCESS_KEY`)
    if (accessKey && secretKey) {
      blockCreds["AWS_ACCESS_KEY_ID"] = accessKey
      blockCreds["AWS_SECRET_ACCESS_KEY"] = secretKey
      blockCreds["AWS_SESSION_TOKEN"] = this.getenv(`${prefix}AWS_SESSION_TOKEN`)
      const region = this.getenv(`${prefix}AWS_REGION`)
      if (region) blockCreds["AWS_REGION"] = region
      found = true
    }

    // Fallback: check without prefix
    if (!found && prefix) {
      const ak = this.getenv("AWS_ACCESS_KEY_ID")
      const sk = this.getenv("AWS_SECRET_ACCESS_KEY")
      if (ak && sk) {
        blockCreds["AWS_ACCESS_KEY_ID"] = ak
        blockCreds["AWS_SECRET_ACCESS_KEY"] = sk
        blockCreds["AWS_SESSION_TOKEN"] = this.getenv("AWS_SESSION_TOKEN")
        const region = this.getenv("AWS_REGION")
        if (region) blockCreds["AWS_REGION"] = region
        found = true
      }
    }

    // Check AWS_PROFILE
    if (!found) {
      const profile = this.getenv("AWS_PROFILE")
      if (profile) {
        blockCreds["AWS_PROFILE"] = profile
        const region = this.getenv("AWS_REGION")
        if (region) blockCreds["AWS_REGION"] = region
        found = true
      }
    }

    // Check OIDC
    if (!found) {
      const roleArn = this.getenv("AWS_ROLE_ARN")
      const tokenFile = this.getenv("AWS_WEB_IDENTITY_TOKEN_FILE")
      if (roleArn && tokenFile) {
        blockCreds["AWS_ROLE_ARN"] = roleArn
        blockCreds["AWS_WEB_IDENTITY_TOKEN_FILE"] = tokenFile
        const region = this.getenv("AWS_REGION")
        if (region) blockCreds["AWS_REGION"] = region
        found = true
      }
    }

    if (!found) {
      this.blockStates.set(block.id, "skipped")
      result.actualStatus = "skipped"
      result.passed = this.matchesExpectedStatus(step.expect, "skipped")
      result.duration = Date.now() - start
      if (this.options.verbose) console.log("--- No AWS credentials found ---")
      return result
    }

    this.authBlockCredentials.set(block.id, blockCreds)

    // Inject explicit credentials into session
    if (blockCreds["AWS_ACCESS_KEY_ID"]) {
      this.sessionEnv = this.sessionEnv.filter(
        (e) => !e.startsWith("AWS_ACCESS_KEY_ID=") &&
               !e.startsWith("AWS_SECRET_ACCESS_KEY=") &&
               !e.startsWith("AWS_SESSION_TOKEN="),
      )
      this.sessionEnv.push(`AWS_ACCESS_KEY_ID=${blockCreds["AWS_ACCESS_KEY_ID"]}`)
      this.sessionEnv.push(`AWS_SECRET_ACCESS_KEY=${blockCreds["AWS_SECRET_ACCESS_KEY"]}`)
      this.sessionEnv.push(`AWS_SESSION_TOKEN=${blockCreds["AWS_SESSION_TOKEN"] ?? ""}`)
      if (blockCreds["AWS_REGION"]) {
        this.sessionEnv = this.sessionEnv.filter((e) => !e.startsWith("AWS_REGION="))
        this.sessionEnv.push(`AWS_REGION=${blockCreds["AWS_REGION"]}`)
      }
    }

    this.blockStates.set(block.id, "success")
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.duration = Date.now() - start
    if (this.options.verbose) console.log("--- AWS credentials found, injected ---")
    return result
  }

  // -----------------------------------------------------------------------
  // GoogleAuth block
  // -----------------------------------------------------------------------

  /**
   * Absolute path of gcloud's well-known `application_default_credentials.json`,
   * or null when the environment says there is no gcloud config root.
   *
   * `CLOUDSDK_CONFIG`, when SET, is authoritative: set-but-empty means "no
   * gcloud config", never "fall back to ~/.config/gcloud". That is what lets a
   * runbook test blank `CLOUDSDK_CONFIG` and get a deterministic skip on a
   * developer machine that happens to have ADC set up. The Windows base is
   * `%APPDATA%\gcloud`, NOT `%LOCALAPPDATA%`.
   */
  private resolveAdcFile(): string | null {
    const configured = this.getenv("CLOUDSDK_CONFIG")
    if (configured) {
      return path.join(configured, "application_default_credentials.json")
    }
    if (this.hasEnv("CLOUDSDK_CONFIG")) return null

    const root =
      process.platform === "win32"
        ? path.join(
            this.getenv("APPDATA") || path.join(os.homedir(), "AppData", "Roaming"),
            "gcloud",
          )
        : path.join(os.homedir(), ".config", "gcloud")
    return path.join(root, "application_default_credentials.json")
  }

  /**
   * First credential-bearing env var set under `prefix`, in detection
   * precedence. Returns the CANONICAL (unprefixed) name to write plus its
   * value, so `RUNBOOKS_TEST_GOOGLE_CREDENTIALS` lands as `GOOGLE_CREDENTIALS`.
   */
  private findGoogleCredential(prefix: string): { name: string; value: string } | null {
    for (const name of GOOGLE_CREDENTIAL_ENV_VARS) {
      const value = this.getenv(`${prefix}${name}`)
      if (value) return { name, value }
    }
    return null
  }

  /**
   * GoogleAuth in headless test mode: resolve a credential the way the block's
   * own detection does and inject the env vars main writes on a successful
   * interactive auth. Like runAwsAuth this never reaches the network, so the
   * credential is taken at face value — the test asserts wiring, not validity.
   */
  private runGoogleAuth(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`googleAuth:${block.id}`, step.expect)

    const prefix = step.env_prefix ?? ""
    const blockCreds: Record<string, string> = {}

    // Prefixed lookup first, then the unprefixed fallback, so a runbook
    // authored for prefixed CI credentials still runs against a developer's
    // ambient ones.
    let credential = this.findGoogleCredential(prefix)
    if (!credential && prefix) credential = this.findGoogleCredential("")

    // Last resort: gcloud's well-known ADC file — the block's `'adc'` source.
    if (!credential) {
      const adcFile = this.resolveAdcFile()
      if (adcFile && fs.existsSync(adcFile)) {
        credential = { name: "GOOGLE_APPLICATION_CREDENTIALS", value: adcFile }
      }
    }

    if (!credential) {
      this.blockStates.set(block.id, "skipped")
      result.actualStatus = "skipped"
      result.passed = this.matchesExpectedStatus(step.expect, "skipped")
      result.duration = Date.now() - start
      if (this.options.verbose) console.log("--- No Google Cloud credentials found ---")
      return result
    }

    blockCreds[credential.name] = credential.value

    // Point the gcloud CLI at the same file. gcloud keeps its own credential
    // store, which otherwise wins over ADC whenever the machine has a
    // `gcloud auth login` account, so a bare `gcloud` would ignore this block.
    if (credential.name === "GOOGLE_APPLICATION_CREDENTIALS") {
      blockCreds["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"] = credential.value
    }

    // A bare access token is exported under both canonical names: gcloud reads
    // CLOUDSDK_AUTH_ACCESS_TOKEN, client libraries read GOOGLE_OAUTH_ACCESS_TOKEN.
    if (
      credential.name === "GOOGLE_OAUTH_ACCESS_TOKEN" ||
      credential.name === "CLOUDSDK_AUTH_ACCESS_TOKEN"
    ) {
      blockCreds["GOOGLE_OAUTH_ACCESS_TOKEN"] = credential.value
      blockCreds["CLOUDSDK_AUTH_ACCESS_TOKEN"] = credential.value
    }

    // Project, region, and zone: environment first (prefixed, then unprefixed),
    // falling back to the props that pin them in the interactive block. None of
    // them is a credential, so none can make an unauthenticated block succeed.
    const project =
      this.firstEnv(prefix, GOOGLE_PROJECT_ENV_VARS) ||
      (prefix ? this.firstEnv("", GOOGLE_PROJECT_ENV_VARS) : "") ||
      extractProp(block.props, "project")
    const region =
      this.firstEnv(prefix, GOOGLE_REGION_ENV_VARS) ||
      (prefix ? this.firstEnv("", GOOGLE_REGION_ENV_VARS) : "") ||
      extractProp(block.props, "defaultRegion")
    const zone =
      this.firstEnv(prefix, GOOGLE_ZONE_ENV_VARS) ||
      (prefix ? this.firstEnv("", GOOGLE_ZONE_ENV_VARS) : "") ||
      extractProp(block.props, "defaultZone")

    if (project) for (const name of GOOGLE_PROJECT_WRITE_VARS) blockCreds[name] = project
    if (region) for (const name of GOOGLE_REGION_WRITE_VARS) blockCreds[name] = region
    if (zone) for (const name of GOOGLE_ZONE_WRITE_VARS) blockCreds[name] = zone

    this.authBlockCredentials.set(block.id, blockCreds)

    // Clear EVERY credential-bearing var, not just the one being written, so an
    // ambient GOOGLE_APPLICATION_CREDENTIALS cannot shadow a token the prefix
    // selected, and an earlier override cannot keep gcloud on another file.
    const stale = new Set<string>([
      ...GOOGLE_CREDENTIAL_ENV_VARS,
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      ...Object.keys(blockCreds),
    ])
    this.sessionEnv = this.sessionEnv.filter((entry) => {
      const eq = entry.indexOf("=")
      return eq === -1 || !stale.has(entry.slice(0, eq))
    })
    for (const [k, v] of Object.entries(blockCreds)) {
      this.sessionEnv.push(`${k}=${v}`)
    }

    this.blockStates.set(block.id, "success")
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.duration = Date.now() - start
    if (this.options.verbose) console.log("--- Google Cloud credentials found, injected ---")
    return result
  }

  // -----------------------------------------------------------------------
  // GitClone block
  // -----------------------------------------------------------------------

  private runGitClone(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`gitClone:${block.id}`, step.expect)

    // A block pointed at an existing checkout clones nothing — it just adopts
    // the directory, mirroring the app's "Use local checkout" source.
    const repoDir = extractProp(block.props, "prefilledRepoDir")
    const source = extractProp(block.props, "source")
    if (source === "local" || (!source && repoDir)) {
      return this.runGitCloneLocal(block, step, start, result, repoDir)
    }

    const cloneURL = extractProp(block.props, "prefilledUrl")
    const ref = extractProp(block.props, "prefilledRef")
    const repoPath = extractProp(block.props, "prefilledRepoPath")
    const localPath = extractProp(block.props, "prefilledLocalPath")

    if (!cloneURL) {
      this.blockStates.set(block.id, "skipped")
      result.actualStatus = "skipped"
      result.passed = this.matchesExpectedStatus(step.expect, "skipped")
      result.duration = Date.now() - start
      if (this.options.verbose) console.log("--- No prefilledUrl specified ---")
      return result
    }

    // Resolve destination path
    let destPath: string
    if (localPath) {
      destPath = path.isAbsolute(localPath) ? localPath : path.join(this.workingDir, localPath)
    } else {
      // Name the directory after the repo, as the app does
      destPath = path.join(this.workingDir, parseOwnerRepoFromURL(cloneURL)?.repo ?? "repo")
    }

    // Inject a token into the URL
    const effectiveURL = this.authenticatedCloneURL(block, cloneURL)

    if (this.options.verbose) {
      console.log(`--- Cloning ${cloneURL} ---`)
      if (ref) console.log(`  Ref: ${ref}`)
      console.log(`  Destination: ${destPath}`)
    }

    try {
      const cloneArgs = ["clone", "--progress"]
      if (repoPath) {
        // Sparse checkout
        cloneArgs.push("--filter=blob:none", "--no-checkout", effectiveURL, destPath)
      } else {
        cloneArgs.push(effectiveURL, destPath)
      }

      execFileSync("git", cloneArgs, {
        timeout: this.options.timeout,
        stdio: "pipe",
      })

      if (repoPath) {
        execFileSync("git", ["sparse-checkout", "init", "--cone"], {
          cwd: destPath, timeout: 30000, stdio: "pipe",
        })
        execFileSync("git", ["sparse-checkout", "set", repoPath], {
          cwd: destPath, timeout: 30000, stdio: "pipe",
        })
        execFileSync("git", ["checkout"], {
          cwd: destPath, timeout: 30000, stdio: "pipe",
        })
      }

      if (ref && !repoPath) {
        execFileSync("git", ["checkout", ref], {
          cwd: destPath, timeout: 30000, stdio: "pipe",
        })
      }
    } catch (e: unknown) {
      result.passed = false; result.actualStatus = "fail"
      // Sanitize error to not leak tokens
      result.error = redactSecrets(String(e))
      result.duration = Date.now() - start
      return result
    }

    // Count files
    const fileCount = countFiles(destPath)

    result.outputs = { clone_path: destPath, file_count: String(fileCount) }
    if (ref) result.outputs["ref"] = ref

    this.blockOutputs.set(block.id, new Map(Object.entries(result.outputs)))

    this.activeWorkTreePath = destPath
    this.blockStates.set(block.id, "success")
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.duration = Date.now() - start

    if (this.options.verbose) {
      console.log(`--- Clone complete: ${fileCount} files ---`)
      console.log("--- Result: ✓ success ---")
    }

    return result
  }

  /**
   * The clone URL with a token in it, chosen by provider, never by host, as
   * main's clone handler does. The token and provider come from the auth block
   * the GitClone references with `gitAuthId` or `githubAuthId`. With no
   * reference, a github.com or gitlab.com URL uses that provider's token from
   * the session env. GitLab takes the token as user `oauth2`, GitHub as
   * `x-access-token`. Only https URLs get a token; SSH authenticates itself.
   */
  private authenticatedCloneURL(block: ParsedComponent, cloneURL: string): string {
    let url: URL
    try { url = new URL(cloneURL) } catch { return cloneURL }
    if (url.protocol !== "https:") return cloneURL

    const authId = extractProp(block.props, "gitAuthId") || extractProp(block.props, "githubAuthId")
    let auth: { provider: GitProvider; token: string } | undefined
    if (authId) {
      auth = this.gitAuthTokens.get(authId)
    } else {
      const host = url.hostname
      const session = envListToRecord(this.sessionEnv)
      if (host === "github.com") {
        auth = { provider: "github", token: session["GITHUB_TOKEN"] || session["GH_TOKEN"] || "" }
      } else if (host === "gitlab.com") {
        auth = { provider: "gitlab", token: session["GITLAB_TOKEN"] || "" }
      }
    }

    if (!auth?.token) return cloneURL
    return injectTokenIntoUrl(cloneURL, auth.token, auth.provider === "gitlab" ? "oauth2" : "x-access-token")
  }

  /**
   * GitClone with `source="local"`: adopt an existing checkout instead of
   * cloning it. Emits the same `clone_path` output and becomes the active
   * worktree, so the rest of the runbook behaves identically either way.
   */
  private runGitCloneLocal(
    block: ParsedComponent,
    step: TestStep,
    start: number,
    result: StepResult,
    repoDir: string | undefined,
  ): StepResult {
    if (!repoDir) {
      this.blockStates.set(block.id, "skipped")
      result.actualStatus = "skipped"
      result.passed = this.matchesExpectedStatus(step.expect, "skipped")
      result.duration = Date.now() - start
      if (this.options.verbose) console.log("--- No prefilledRepoDir specified ---")
      return result
    }

    const resolved = path.isAbsolute(repoDir) ? repoDir : path.join(this.workingDir, repoDir)

    let repoRoot: string
    try {
      repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: resolved,
        timeout: 30000,
        stdio: "pipe",
      })
        .toString()
        .trim()
    } catch (e: unknown) {
      result.passed = this.matchesExpectedStatus(step.expect, "fail")
      result.actualStatus = "fail"
      result.error = `Not a git repository: ${resolved} (${String(e)})`
      result.duration = Date.now() - start
      return result
    }

    // Count TRACKED files, as the app does for a local checkout: walking the
    // directory would count .git internals and ignored build output, which say
    // nothing about the repo the user picked.
    let fileCount = 0
    try {
      const tracked = execFileSync("git", ["ls-files"], {
        cwd: repoRoot,
        timeout: 30000,
        stdio: "pipe",
      }).toString()
      fileCount = tracked.split("\n").filter((line) => line.trim() !== "").length
    } catch {
      // Best-effort: a repo with no commits still counts as usable.
    }

    result.outputs = { clone_path: repoRoot, file_count: String(fileCount) }
    this.blockOutputs.set(block.id, new Map(Object.entries(result.outputs)))

    this.activeWorkTreePath = repoRoot
    this.blockStates.set(block.id, "success")
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.duration = Date.now() - start

    if (this.options.verbose) {
      console.log(`--- Using local checkout ${repoRoot}: ${fileCount} files ---`)
      console.log("--- Result: ✓ success ---")
    }

    return result
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildTemplateVars(): Record<string, unknown> {
    const inputs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(this.testInputs)) {
      const parts = key.split(".", 2)
      if (parts.length === 2) {
        inputs[parts[1]] = value
      }
    }

    const outputs: Record<string, unknown> = {}
    for (const [blockId, blockOutputs] of this.blockOutputs) {
      const templateBlockId = blockId.replace(/-/g, "_")
      const obj: Record<string, string> = {}
      for (const [k, v] of blockOutputs) obj[k] = v
      outputs[templateBlockId] = obj
    }

    return { inputs, outputs }
  }

  private matchesExpectedStatus(expected: ExpectedStatus, actual: string): boolean {
    switch (expected) {
      case "success": return actual === "success"
      case "fail": return actual === "fail"
      case "warn": return actual === "warn"
      case "blocked": return actual === "blocked"
      case "skip": return actual === "skipped"
      case "config_error": return actual === "config_error"
      default: return false
    }
  }

  private checkMissingOutputs(expected: string[]): string[] {
    // Look outputs up the way templates reference them: buildTemplateVars keys
    // them by block id with hyphens turned into underscores, so
    // `outputs.create_account.account_id` finds block "create-account".
    const templateOutputs = this.buildTemplateVars().outputs as Record<string, Record<string, string>>
    const missing: string[] = []
    for (const p of expected) {
      const parts = p.split(".")
      if (parts.length >= 3 && parts[0] === "outputs") {
        const blockId = parts[1].replace(/-/g, "_")
        const outputName = parts[2]
        const outputs = templateOutputs[blockId]
        if (!outputs || !outputs[outputName]) {
          missing.push(p)
        }
      }
    }
    return missing
  }

  private makeAssertionCtx(): AssertionContext {
    return {
      outputDir: this.resolveOutputPath(),
      blockOutputs: this.blockOutputs,
      generatedFiles: this.generatedFileCounts,
      sessionEnv: this.sessionEnv,
      timeout: this.options.timeout,
    }
  }

  private formatBlockError(block: ParsedComponent, stepResult: StepResult): string {
    if (stepResult.errorDisplayed) {
      return `${block.type} block '${block.id}' failed (see details above)`
    }

    let msg: string
    if (stepResult.error) {
      msg = `${block.type} block '${block.id}': ${stepResult.error}`
    } else {
      msg = `${block.type} block '${block.id}' failed with status: ${stepResult.actualStatus}`
    }

    if (stepResult.logs) {
      const lines = stepResult.logs.trim().split("\n")
      const maxLines = 20
      const truncated = lines.length > maxLines
        ? [`... (${lines.length - maxLines} lines truncated) ...`, ...lines.slice(-maxLines)]
        : lines
      msg += `\n\n--- Script Output ---\n${truncated.join("\n")}`
    }

    return msg
  }

  private printBlockOutput(
    _blockId: string,
    logs: string,
    outputs: Record<string, string>,
    status: string,
    error?: string,
  ): void {
    if (logs) {
      console.log("--- Script Output ---")
      for (const line of logs.trimEnd().split("\n")) {
        console.log(`  ${line}`)
      }
    }
    if (Object.keys(outputs).length > 0) {
      console.log("--- Outputs ---")
      for (const [key, value] of Object.entries(outputs)) {
        const display = value.length > 100 ? value.slice(0, 97) + "..." : value
        console.log(`  ${key} = ${display}`)
      }
    }
    const icon = (status === "success" || status === "warn") ? "✓" : "✗"
    console.log(`--- Result: ${icon} ${status} ---`)
    if (error) console.log(`  Error: ${error}`)
  }

  /** Copy a block's $GENERATED_FILES tree into `toDir`. Returns the number of files copied. */
  private captureFiles(fromDir: string, toDir: string): number {
    if (!fs.existsSync(fromDir)) return 0
    let copied = 0
    const entries = fs.readdirSync(fromDir, { withFileTypes: true })
    for (const entry of entries) {
      const src = path.join(fromDir, entry.name)
      const dest = path.join(toDir, entry.name)
      if (entry.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true })
        copied += this.captureFiles(src, dest)
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
        copied++
      }
    }
    return copied
  }

  /**
   * Add to the files a block has written this test case. files_generated
   * checks this count rather than the output dir, which can hold files from
   * other blocks and which worktree-targeted templates don't write into.
   */
  private creditGeneratedFiles(blockId: string, count: number): void {
    this.generatedFileCounts.set(blockId, (this.generatedFileCounts.get(blockId) ?? 0) + count)
  }

  /**
   * Run one cleanup action. A `path` script is read relative to the runbook's
   * directory; both forms run with the output directory as cwd, which is
   * created first because nothing else does unless a block generated files.
   */
  private runCleanup(action: { command?: string; path?: string }): void {
    const label = action.command || action.path
    if (!label) return

    try {
      const script = action.command
        || fs.readFileSync(path.join(path.dirname(this.runbookPath), action.path!), "utf-8")
      const cwd = this.resolveOutputPath()
      fs.mkdirSync(cwd, { recursive: true })
      execFileSync("/bin/bash", ["-c", script], {
        cwd,
        timeout: 30000,
        stdio: "pipe",
      })
    } catch (e: unknown) {
      // Non-fatal, but never silent: a skipped teardown can leak real resources.
      console.warn(`  ⚠ cleanup "${label}" failed: ${describeCleanupError(e)}`)
    }
  }
}

/** A short reason for a failed cleanup that doesn't echo the whole script back. */
function describeCleanupError(e: unknown): string {
  const { status, stderr } = (e ?? {}) as { status?: number | null; stderr?: Buffer | string }
  if (typeof status === "number") {
    const detail = stderr?.toString().trim()
    return detail ? `exit code ${status}: ${detail}` : `exit code ${status}`
  }
  return e instanceof Error ? e.message : String(e)
}
