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
import { Effect, Result, ManagedRuntime } from "effect"

import { ExecutableRegistry } from "../../src/domain/registry/executable.ts"
import { openSqliteDatabase } from "../../src/layers/NodeSqlite.ts"
import { runQuery, runSqlScript } from "../../src/domain/sqlite/query.ts"
import type { SqlParam, SqlQueryResult } from "../../src/domain/sqlite/result.ts"
import { stringArrayProp, stringProp, type PropValue, type Props } from "../../src/mdx.ts"
import { NodeFileSystemLive } from "../../src/layers/NodeFileSystem.ts"
import { buildCloneSteps } from "../../src/domain/git/cloneSteps.ts"
import {
  githubEnvCredentialForHost,
  githubSessionCredential,
} from "../../src/domain/github/auth.ts"
import {
  DEFAULT_GITHUB_HOST,
  isGitHubHost,
  tryNormalizeGitHubHost,
} from "../../src/domain/git/github-host.ts"
import { gitCredentialUsername, withGitHttpAuth } from "../../src/domain/git/url.ts"
import {
  parseBlockOutputsContent,
  parseEnvCaptureContent,
  resolveScriptRunner,
  wrapBashScript,
} from "../../src/domain/exec/script.ts"
import {
  LEVEL_LOG_CHANNELS,
  RUNBOOK_LOG_CHANNEL,
  logChannelFiles,
  orderLogChannelLines,
  tagLogLine,
} from "../../src/domain/exec/logChannels.ts"
import { extractToolList, parsePrerequisitesSpec } from "../../src/domain/prerequisites/spec.ts"
import {
  LOOKUP_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  lookupArgs,
  parseLookupOutput,
  probeArgs,
} from "../../src/domain/prerequisites/lookup.ts"
import {
  checkLog,
  checkTool,
  lookupFailedLog,
  prerequisitesOutputs,
  prerequisitesStatus,
  statusExitCode,
  type LogEntry,
  type PrerequisitesStatus,
  type RunFailure,
} from "../../src/domain/prerequisites/results.ts"
import {
  maskOutput,
  maskOutputs,
  revealOutputs,
  type OutputValue,
  type OutputValues,
} from "../../src/domain/exec/outputValues.ts"
import { filterCapturedEnv } from "../../src/domain/session/manager.ts"
import { parseOwnerRepoFromURL } from "../../src/domain/git/operations.ts"
import { tryNormalizeGitLabHost } from "../../src/domain/git/gitlab-host.ts"
import {
  GITLAB_TOKEN_ENV_VARS,
  envTokenHost,
  gitlabSessionTokenHost,
  mayAutoSendEnvToken,
} from "../../src/domain/gitlab/auth.ts"
import { redactSecrets } from "../../src/domain/vcs/redact.ts"
import { untouchedValue } from "../../src/domain/boilerplate/untouchedValue.ts"
import {
  optionFields,
  optionMembershipError,
  parseOutputOptions,
} from "../../src/domain/boilerplate/options.ts"
import type { Executable } from "../../src/types.ts"
import { extractOutputDependencies } from "../../src/domain/boilerplate/config.ts"

import type { TestCase, TestStep, ExpectedStatus, TestResult, StepResult } from "./config.ts"
import { resolveTestInputs } from "./fuzz.ts"
import { runAssertion, countFiles, envListToRecord, type AssertionContext } from "./assertions.ts"
import {
  InputValidator,
  type InputsBlockSchema,
  type ValidationError,
  inputsIdsOf,
  parseAuthDependencies,
  parseRunDependencies,
  parseShowWhenBlocks,
  parseTemplateInlineBlocks,
  parseTemplateBlocks,
  lowercaseFirst,
  type TemplateInlineBlock,
  type TemplateBlock,
  type AuthDependency,
} from "./validation.ts"
import { AUTH_BLOCK_TYPES, PR_BLOCK_TYPES } from "./blockTypes.ts"
import { AZURE_AUTH_ENV_VARS } from "../../src/domain/exec/authEnv.ts"
import { unknownBlocksError } from "../../src/runbooks-version.ts"
import type { ParsedComponent } from "../../src/domain/registry/executable.ts"
import { errorMessage } from "../../src/errors/message.ts"
import { scriptTemplateWarning } from "../../src/domain/exec/scriptTemplates.ts"
import {
  describeShowWhenBlock,
  showWhenBlockHolds,
  type ShowWhenBlock,
} from "../../src/domain/exec/showWhenBlock.ts"

// ---------------------------------------------------------------------------
// Block types & states
// ---------------------------------------------------------------------------

type BlockState = "success" | "skipped"

/** How a Check, Command, Finish or Prerequisites block's latest run ended. */
type ScriptResult = "success" | "warn" | "fail"

type GitProvider = "github" | "gitlab"

const AUTH_BLOCK_SET = new Set<string>(AUTH_BLOCK_TYPES)
const PR_BLOCK_SET = new Set<string>(PR_BLOCK_TYPES)
// Block names by the lowercase componentType the registry gives script entries
const SCRIPT_BLOCK_NAMES = new Map([
  ["command", "Command"],
  ["check", "Check"],
  ["finish", "Finish"],
])

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
type GitAuthLookup = { token: string; vars: Record<string, string> } | { skipReason: string }

/** Build a StepResult with its mutable fields freshly initialized per call. */
function makeStepResult(block: string, expectedStatus: ExpectedStatus): StepResult {
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

/**
 * Whether the repository at `repoDir` has any commits (its HEAD resolves).
 * `env` is the environment the clone's other git commands run with. As in the
 * app, only an unborn HEAD (`rev-parse --verify` exits 1) counts as no
 * commits. Any other failure (dubious ownership, a corrupt repo, git not
 * starting) counts as having them, so the checkout runs and fails with the
 * real error instead of passing an empty clone.
 */
function hasCommits(repoDir: string, env: NodeJS.ProcessEnv): boolean {
  const proc = spawnSync("git", ["-C", repoDir, "rev-parse", "--verify", "-q", "HEAD"], {
    stdio: "ignore",
    env,
  })
  return proc.status !== 1
}

// ---------------------------------------------------------------------------
// Go template renderer (simple subset for runbook scripts/templates)
// ---------------------------------------------------------------------------

/**
 * Render a Go text/template-compatible string with the given variables.
 * Supports: {{ .path.to.value }} and {{ if .x }}...{{ else }}...{{ end }}.
 * This is a simplified renderer covering patterns used in runbook tests.
 */
function renderGoTemplate(content: string, vars: Record<string, unknown>): string {
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
  result = result.replace(/\{\{\s*\.([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, keyPath: string) => {
    const value = resolveDotPath(vars, keyPath)
    if (value === undefined || value === null) {
      throw new Error(`Template references {{.${keyPath}}} but that variable is not defined`)
    }
    return templateText(value)
  })

  // Handle {{ fromJson .path.to.value }} (returns parsed JSON)
  result = result.replace(
    /\{\{\s*fromJson\s+\.([a-zA-Z0-9_.]+)\s*\}\}/g,
    (_match, keyPath: string) => {
      const value = resolveDotPath(vars, keyPath)
      if (value === undefined) return ""
      const text = templateText(value)
      try {
        return JSON.stringify(JSON.parse(text))
      } catch {
        return text
      }
    },
  )

  return result
}

/** A block's props with the templates in their strings, nested ones included, rendered. */
function renderPropTemplates(props: Props, vars: Record<string, unknown>): Props {
  const render = (value: PropValue): PropValue => {
    if (typeof value === "string") {
      return value.includes("{{") ? renderGoTemplate(value, vars) : value
    }
    if (Array.isArray(value)) return value.map(render)
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]))
    }
    return value
  }
  return Object.fromEntries(Object.entries(props).map(([name, value]) => [name, render(value)]))
}

/**
 * The text a template variable renders as: a primitive as itself, a list
 * comma-joined (as String() joins an array), and a map as JSON rather than
 * "[object Object]".
 */
function templateText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  if (Array.isArray(value)) return value.map(templateText).join(",")
  return JSON.stringify(value) ?? ""
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

/** The blocks whose templates read inputs, and so check options that come from an output before they run. */
const OPTION_READING_BLOCK_TYPES = new Set(["Template", "TemplateInline", "Check", "Command"])

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
  private runDeps!: Map<string, string[]>
  // Each Check, Command and Finish block's `showWhenBlock` condition, by block ID
  private showWhenBlocks!: Map<string, ShowWhenBlock>
  // The blocks each block reads `.inputs` from, by block ID (inputsIdsOf)
  private inputsIds!: Map<string, string[]>

  // process.env as captured by init(); every test starts from a copy
  private initialSessionEnv: string[] = []

  // Per-test state (reset each test)
  private workingDir: string
  private sessionEnv: string[] = []
  private sessionWorkDir: string
  // Sensitive outputs are Redacted: templates reveal them, printing masks them
  private blockOutputs = new Map<string, Map<string, OutputValue>>()
  // Files each block wrote this test case, by block ID, for files_generated
  private generatedFileCounts = new Map<string, number>()
  private testInputs: Record<string, unknown> = {}
  private testEnv: Record<string, string> = {}
  private blockStates = new Map<string, BlockState>()
  // How the latest run of each Check, Command, Finish and Prerequisites block
  // ended this test case, by normalized block ID, for `dependsOn` and
  // `showWhenBlock`. A timeout counts as a failure, as in the app.
  private scriptResults = new Map<string, ScriptResult>()
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
      this.registry = await runtime.runPromise(ExecutableRegistry.create(this.runbookPath))
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
    this.runDeps = parseRunDependencies(this.runbookPath)
    this.showWhenBlocks = parseShowWhenBlocks(this.runbookPath)
    this.inputsIds = new Map(
      this.validator.getComponents().map((block) => [block.id, inputsIdsOf(block)]),
    )

    // Capture initial environment
    this.initialSessionEnv = Object.entries(process.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
  }

  /**
   * A warning for each Command, Check or Finish script that inserts inputs or
   * outputs into its source, naming the block. The scripts still run.
   */
  scriptTemplateWarnings(): string[] {
    const warnings: string[] = []
    for (const id of Object.keys(this.registry.getAllExecutables())) {
      const entry = this.registry.getExecutableSync(id)
      const blockName = entry && SCRIPT_BLOCK_NAMES.get(entry.componentType)
      if (!entry || !blockName) continue
      const warning = scriptTemplateWarning(entry.content)
      if (warning) warnings.push(`${blockName} "${entry.componentId}": ${warning}`)
    }
    return warnings
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

  /**
   * The session env with the test case's `env` on top, as every block and
   * script assertion sees it. The test's `env` always wins, so it can blank a
   * variable whether or not an earlier bash block has captured it yet.
   */
  private sessionEnvWithTestEnv(): Record<string, string> {
    return { ...envListToRecord(this.sessionEnv), ...this.testEnv }
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

    // 0. Check for blocks this version doesn't have
    const unknown = this.getUnknownBlockTypes()
    if (unknown.length > 0) {
      result.status = "failed"
      result.error = unknownBlocksError(unknown)
      result.duration = Date.now() - start
      return result
    }

    // 1. Resolve test inputs (fuzz + literal)
    let resolvedInputs: Record<string, unknown>
    try {
      resolvedInputs = resolveTestInputs(tc.inputs)
    } catch (e: unknown) {
      result.status = "failed"
      result.error = `Failed to resolve test config: ${errorMessage(e)}`
      result.duration = Date.now() - start
      return result
    }

    // Fill in the variables the test doesn't set. A variable x-show-when
    // hides gets its default, as the form reports it.
    resolvedInputs = this.completeInputs(resolvedInputs)

    // 2. Validate inputs against schemas
    const validationErrors = this.validator.validateInputValues(resolvedInputs)
    if (validationErrors.length > 0) {
      result.status = "failed"
      result.error =
        "Input validation failed:\n" +
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

    this.resetState(resolvedInputs, tc.env ?? {}, workingDir)

    // 3. Get all blocks in document order
    const allBlocks = this.validator.getComponents()

    // 4. Pair each block to run with its step. Explicit steps run in the order
    // listed, so a block can run more than once with a different expectation
    // each time; without steps, every block runs once in document order,
    // expected to succeed, except PR blocks, which never run in test mode.
    // A step the test doesn't list (`implicit`) passes when its block is
    // hidden by `showWhenBlock`, since the block isn't shown in the app either.
    const plan: Array<{ block: ParsedComponent; step: TestStep; implicit?: boolean }> = []
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
        plan.push({ block, step: { block: block.id, expect }, implicit: true })
      }
    }

    const registryWarnings = this.registry.getWarnings()

    // Cleanup runs however the test ends (a failed block or assertion, or an
    // unexpected throw) so teardown is never skipped.
    try {
      // 5. Process each planned step
      for (const { block, step, implicit = false } of plan) {
        const stepResult = this.processBlock(block, step, registryWarnings, implicit)
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

  /** `set` with every variable it leaves out filled in, as the app's form starts them. */
  private completeInputs(set: Record<string, unknown>): Record<string, unknown> {
    return this.validator.withHiddenDefaults({ ...this.fillUnsetInputs(set), ...set })
  }

  /** Start over: no block has run, and the session env and cwd are the initial ones. */
  private resetState(
    inputs: Record<string, unknown>,
    env: Record<string, string>,
    workingDir: string,
  ): void {
    this.testInputs = inputs
    this.testEnv = env
    this.workingDir = workingDir
    this.sessionEnv = [...this.initialSessionEnv]
    this.sessionWorkDir = workingDir
    this.blockOutputs = new Map()
    this.generatedFileCounts = new Map()
    this.blockStates = new Map()
    this.scriptResults = new Map()
    this.authBlockCredentials = new Map()
    this.gitAuthTokens = new Map()
    this.activeWorkTreePath = ""
  }

  // -----------------------------------------------------------------------
  // Interactive sessions (runbooks-cli mcp)
  //
  // The same engine as runTest, one block at a time: a caller starts a
  // session, sets inputs as it learns them, and runs the blocks it chooses.
  // State carries from block to block as it does within a test case.
  // -----------------------------------------------------------------------

  /** The blocks the runner can run, in document order. */
  getBlocks(): ParsedComponent[] {
    return this.validator.getComponents()
  }

  /** The variables of each Inputs and Template block, by block ID. */
  getInputSchemas(): Map<string, InputsBlockSchema> {
    return this.validator.getAllSchemas()
  }

  /** The blocks block `blockId` reads `.inputs` from, in the order the app merges them. */
  getInputsIds(blockId: string): string[] {
    return this.inputsIds.get(blockId) ?? []
  }

  /** The blocks block `blockId` names in `dependsOn`. */
  getRunDependencies(blockId: string): string[] {
    return this.runDeps.get(blockId) ?? []
  }

  /** The auth block block `blockId` references, if any. */
  getAuthDependency(blockId: string): AuthDependency | undefined {
    return this.authDeps.get(blockId)
  }

  /** The configuration error the app would show in place of block `blockId`, or "". */
  getBlockConfigError(block: ParsedComponent): string {
    return this.getConfigErrorForBlock(block, this.registry.getWarnings())
  }

  /** The block types in the runbook that this version doesn't have. */
  getUnknownBlockTypes(): string[] {
    return this.validator
      .getConfigErrors()
      .filter((err) => err.componentId === "(unknown)")
      .map((err) => err.componentType)
  }

  /**
   * Start an interactive session in `workingDir`: no block has run yet.
   * `inputs` are set as with setSessionInputs, and `env` goes on top of the
   * environment, as a test case's `env` does.
   */
  beginSession(
    inputs: Record<string, unknown>,
    env: Record<string, string>,
    workingDir: string,
  ): ValidationError[] {
    this.resetState({}, env, workingDir)
    return this.setSessionInputs(inputs)
  }

  /**
   * Replace the session's inputs (keys `inputsID.varName`) and fill in the
   * rest as the form starts them. Returns the problems with the values set;
   * the values are kept either way, so a caller can fix one at a time.
   */
  setSessionInputs(inputs: Record<string, unknown>): ValidationError[] {
    this.testInputs = this.completeInputs(inputs)
    return this.validator.validateInputValues(this.testInputs)
  }

  /** The session's inputs, every variable the form would start included. */
  getSessionInputs(): Record<string, unknown> {
    return { ...this.testInputs }
  }

  /** Every block's outputs so far, by block ID, a sensitive one as `<redacted>`. */
  getSessionOutputs(): Record<string, Record<string, string>> {
    const outputs: Record<string, Record<string, string>> = {}
    for (const [blockId, blockOutputs] of this.blockOutputs) {
      outputs[blockId] = maskOutputs(Object.fromEntries(blockOutputs))
    }
    return outputs
  }

  /** The directory generated files go to. */
  getOutputDir(): string {
    return this.resolveOutputPath()
  }

  /**
   * Run one step in the session: a block, its expectation, and the step
   * options (env_prefix, set_outputs). The result's actualStatus is what
   * happened; `passed` compares it with `step.expect`.
   */
  runSessionStep(step: TestStep): StepResult {
    const block = this.getBlocks().find((b) => b.id === step.block)
    if (!block) {
      const result = makeStepResult(step.block, step.expect)
      result.passed = false
      result.actualStatus = "error"
      result.error = `The runbook has no block "${step.block}"`
      return result
    }
    return this.processBlock(block, step, this.registry.getWarnings(), false)
  }

  /**
   * Why block `blockId` can't run yet, each reason a sentence; empty when
   * nothing is missing. Covers what the app waits for before it enables the
   * block's Run button: its auth block, its `dependsOn` blocks, the block
   * outputs its templates read, and the inputs it reads that have no value
   * or an invalid one.
   */
  blockedReasons(blockId: string): string[] {
    const block = this.getBlocks().find((b) => b.id === blockId)
    if (!block) return []
    const reasons: string[] = []

    const authDep = this.authDeps.get(blockId)
    if (authDep) {
      const state = this.blockStates.get(authDep.authBlockId)
      if (state === undefined) {
        reasons.push(`Auth block "${authDep.authBlockId}" hasn't run yet`)
      } else if (state === "skipped") {
        reasons.push(`Auth block "${authDep.authBlockId}" was skipped or found no credentials`)
      }
    }

    const unmet = (this.runDeps.get(blockId) ?? []).filter((id) => !this.hasPassed(id))
    if (unmet.length > 0) {
      reasons.push(
        `dependsOn: ${unmet.map((id) => `"${id}"`).join(", ")} hasn't run with success or warn`,
      )
    }

    const outputs = this.templateOutputs()
    const missingOutputs = new Set<string>()
    for (const dep of extractOutputDependencies(...this.blockSources(block))) {
      if (dep.optional) continue
      const value = outputs[normalizeBlockId(dep.blockId)]?.[dep.outputName]
      if (value === undefined) missingOutputs.add(`outputs.${dep.blockId}.${dep.outputName}`)
    }
    if (missingOutputs.size > 0) {
      reasons.push(`Waiting for block outputs: ${[...missingOutputs].join(", ")}`)
    }

    const schemas = this.validator.getAllSchemas()
    const unset: string[] = []
    const imported = new Set<string>()
    const visit = (id: string) => {
      if (imported.has(id)) return
      imported.add(id)
      for (const importedId of this.templates.get(id)?.inputsIds ?? []) visit(importedId)
    }
    for (const id of this.inputsIds.get(blockId) ?? []) visit(id)
    for (const id of imported) {
      for (const name of schemas.get(id)?.variables.keys() ?? []) {
        const key = `${id}.${name}`
        if (this.testInputs[key] === undefined) unset.push(key)
      }
    }
    if (unset.length > 0) reasons.push(`Inputs without a value: ${unset.join(", ")}`)
    const invalid = this.validator
      .validateInputValues(this.testInputs)
      .filter((err) => imported.has(err.inputKey.split(".", 1)[0] ?? ""))
    if (invalid.length > 0) {
      reasons.push(
        `Invalid inputs: ${invalid.map((err) => `${err.inputKey}: ${err.message}`).join("; ")}`,
      )
    }

    return reasons
  }

  /**
   * The text of block `block` that templates are rendered in: its props,
   * its script and env for a script block, and its template's files.
   */
  blockSources(block: ParsedComponent): string[] {
    const sources: string[] = []
    const collect = (value: PropValue): void => {
      if (typeof value === "string") sources.push(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect)
    }
    Object.values(block.props).forEach(collect)

    for (const [id, entry] of Object.entries(this.registry.getAllExecutables())) {
      if (entry.componentId !== block.id) continue
      const executable = this.registry.getExecutableSync(id)
      if (executable) sources.push(executable.content, ...Object.values(executable.env))
    }
    const inline = this.templateInlines.get(block.id)
    if (inline) sources.push(inline.content)
    const tmpl = this.templates.get(block.id)
    if (tmpl) {
      const walk = (dir: string): void => {
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          // The files renderTemplateDir skips aren't rendered, so they wait for nothing
          if (entry.name === "boilerplate.yml" || entry.name.startsWith(".")) continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else
            try {
              sources.push(fs.readFileSync(full, "utf-8"))
            } catch {}
        }
      }
      walk(path.join(path.dirname(this.runbookPath), tmpl.templatePath))
    }
    return sources
  }

  /** `text` with the value of every sensitive input replaced by `<redacted>`. */
  redactSensitiveInputs(text: string): string {
    const secrets: string[] = []
    for (const [blockId, schema] of this.validator.getAllSchemas()) {
      for (const variable of schema.variables.values()) {
        if (!variable.sensitive) continue
        const value = this.testInputs[`${blockId}.${variable.name}`]
        if (typeof value === "string" && value !== "") secrets.push(value)
      }
    }
    // Longest first, so a secret that contains another is replaced whole
    secrets.sort((a, b) => b.length - a.length)
    return secrets.reduce((out, secret) => out.split(secret).join("<redacted>"), text)
  }

  /**
   * The Inputs and Template blocks whose values block `blockId` reads, itself
   * included for an Inputs or Template block, following Templates' imports.
   * In document order.
   */
  formsReadBy(blockId: string): string[] {
    const schemas = this.validator.getAllSchemas()
    const found = new Set<string>()
    const visit = (id: string) => {
      if (found.has(id)) return
      found.add(id)
      for (const importedId of this.templates.get(id)?.inputsIds ?? []) visit(importedId)
    }
    const block = this.getBlocks().find((b) => b.id === blockId)
    if (block && schemas.has(blockId)) visit(blockId)
    for (const id of this.inputsIds.get(blockId) ?? []) visit(id)
    const order = this.getBlocks().map((b) => b.id)
    return [...found]
      .filter((id) => schemas.has(id))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
  }

  /**
   * The variables of form `formId` that the form itself asks for: not
   * x-hidden, not locked, and for a Template not one a block it imports also
   * declares (the app shows those read-only, with the imported value).
   */
  formOwnVariables(formId: string): string[] {
    const schemas = this.validator.getAllSchemas()
    const imported = new Set<string>()
    for (const id of this.templates.get(formId)?.inputsIds ?? []) {
      for (const name of schemas.get(id)?.variables.keys() ?? []) imported.add(name)
    }
    return [...(schemas.get(formId)?.variables.values() ?? [])]
      .filter((v) => !v.hidden && !v.locked && !imported.has(v.name))
      .map((v) => v.name)
  }

  /**
   * The blocks that wait on block `blockId`: those whose templates read its
   * outputs (and which ones), those that name it in `dependsOn`, and those
   * that use it as their auth block.
   */
  dependentsOf(
    blockId: string,
  ): Array<{ block: string; outputs?: string[]; dependsOn?: true; authBlock?: true }> {
    const target = normalizeBlockId(blockId)
    const result: Array<{ block: string; outputs?: string[]; dependsOn?: true; authBlock?: true }> =
      []
    for (const block of this.getBlocks()) {
      if (block.id === blockId) continue
      const outputs = new Set<string>()
      for (const dep of extractOutputDependencies(...this.blockSources(block))) {
        if (normalizeBlockId(dep.blockId) === target) outputs.add(dep.outputName)
      }
      const dependsOn = (this.runDeps.get(block.id) ?? []).some(
        (id) => normalizeBlockId(id) === target,
      )
      const authBlock = this.authDeps.get(block.id)?.authBlockId === blockId
      if (outputs.size === 0 && !dependsOn && !authBlock) continue
      result.push({
        block: block.id,
        ...(outputs.size > 0 ? { outputs: [...outputs] } : {}),
        ...(dependsOn ? { dependsOn: true as const } : {}),
        ...(authBlock ? { authBlock: true as const } : {}),
      })
    }
    return result
  }

  // -----------------------------------------------------------------------
  // Block processing
  // -----------------------------------------------------------------------

  private processBlock(
    block: ParsedComponent,
    step: TestStep,
    registryWarnings: string[],
    implicit: boolean,
  ): StepResult {
    const start = Date.now()

    const result = makeStepResult(`${lowercaseFirst(block.type)}:${block.id}`, step.expect)

    // 1. Check for config errors
    const configError = this.getConfigErrorForBlock(block, registryWarnings)

    if (configError) {
      result.actualStatus = "config_error"
      result.error = configError

      if (step.expect === "config_error") {
        if (
          step.error_contains &&
          !configError.toLowerCase().includes(step.error_contains.toLowerCase())
        ) {
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

    // 3. Check `showWhenBlock`. A block whose condition doesn't hold is hidden
    // in the app, so it doesn't run. `expect: hidden` asserts that, and a
    // block the test doesn't list passes hidden. `expect: skip` skips the
    // block either way.
    const hiddenResult = this.showWhenBlockResult(block, step, implicit, result)
    if (hiddenResult) {
      hiddenResult.duration = Date.now() - start
      return hiddenResult
    }

    // 4. Check auth dependencies. A block whose auth block hasn't run, or was
    // skipped, is blocked, which is what an `expect: blocked` step asserts.
    // `expect: skip` skips the block whatever state its auth block is in.
    if (step.expect !== "skip" && this.authDeps.has(block.id)) {
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
        result.passed = step.expect === "blocked"
        result.actualStatus = "blocked"
        result.error = `Block depends on "${authDep.authBlockId}" which was skipped`
        result.duration = Date.now() - start
        return result
      }
    }

    // 5. Check `dependsOn`. A block is blocked until every block it names has
    // run and ended in success or warn, as its Run button is in the app.
    if (step.expect !== "skip") {
      const unmet = (this.runDeps.get(block.id) ?? []).filter((id) => !this.hasPassed(id))
      if (unmet.length > 0) {
        result.passed = step.expect === "blocked"
        result.actualStatus = "blocked"
        result.error = `Block depends on ${unmet.map((id) => `"${id}"`).join(", ")} which hasn't run successfully`
        result.duration = Date.now() - start
        return result
      }
    }

    // 6. Dispatch block
    return this.dispatchBlock(block, step, start)
  }

  /** Whether the latest run of the block with this id ended in success or warn. */
  private hasPassed(blockId: string): boolean {
    const latest = this.scriptResults.get(normalizeBlockId(blockId))
    return latest === "success" || latest === "warn"
  }

  /**
   * The step's result when `showWhenBlock` decides it: the block is hidden,
   * or the step expects it to be and it isn't. Null when the block runs.
   */
  private showWhenBlockResult(
    block: ParsedComponent,
    step: TestStep,
    implicit: boolean,
    result: StepResult,
  ): StepResult | null {
    if (step.expect === "skip") return null
    const condition = this.showWhenBlocks.get(block.id) ?? null
    const latest = condition ? this.scriptResults.get(normalizeBlockId(condition.id)) : undefined
    const shown = showWhenBlockHolds(condition, latest)

    if (!shown && condition) {
      const why = `it shows only when ${describeShowWhenBlock(condition)}, and "${condition.id}" ${latest ? `ended in ${latest}` : "hasn't run"}`
      result.actualStatus = "hidden"
      result.passed = implicit || step.expect === "hidden"
      if (!result.passed) result.error = `Block is hidden: ${why}`
      if (this.options.verbose) {
        console.log(`\n=== ${block.type}: ${block.id} ===`)
        console.log(`  (hidden: ${why})`)
      }
      return result
    }
    if (step.expect === "hidden") {
      result.actualStatus = "shown"
      result.passed = false
      result.error = condition
        ? `Expected block to be hidden, but "${condition.id}" ended in ${latest}`
        : "Expected block to be hidden, but it has no showWhenBlock"
      return result
    }
    return null
  }

  private getConfigErrorForBlock(block: ParsedComponent, registryWarnings: string[]): string {
    if (
      block.type === "Check" ||
      block.type === "Command" ||
      block.type === "Finish" ||
      block.type === "Prerequisites"
    ) {
      const warning = registryWarnings.find((w) => w.includes(`id="${block.id}"`))
      if (warning) return warning
    }
    return this.validator.getConfigError(block.type, block.id)
  }

  // -----------------------------------------------------------------------
  // Block dispatch
  // -----------------------------------------------------------------------

  private dispatchBlock(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`${lowercaseFirst(block.type)}:${block.id}`, step.expect)

    if (this.options.verbose) {
      console.log(`\n=== ${block.type}: ${block.id} ===`)
    }

    if (step.set_outputs !== undefined && block.type !== "Iframe") {
      result.passed = false
      result.actualStatus = "error"
      result.error = `set_outputs only applies to Iframe blocks, not ${block.type}`
      result.duration = Date.now() - start
      return result
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
        result.passed = true
        result.actualStatus = "blocked"
        result.error = `Blocked due to missing outputs: ${missing.join(", ")}`
      } else {
        result.passed = false
        result.actualStatus = "not_blocked"
        result.error = "Expected block to be blocked but all dependencies are satisfied"
      }
      result.duration = Date.now() - start
      return result
    }

    // Render template vars in block props. The app resolves props for display
    // and shows a sensitive output in them as <redacted>, so they get the
    // same here.
    try {
      block = {
        ...block,
        props: renderPropTemplates(block.props, this.buildTemplateVars(block.id, maskOutputs)),
      }
    } catch (e: unknown) {
      result.passed = false
      result.actualStatus = "error"
      result.error = `Failed to render template in block props: ${errorMessage(e)}`
      result.duration = Date.now() - start
      return result
    }

    // The inputs a block reads whose options come from a block's output can
    // only be checked once that output exists, so they are checked here, as
    // the form checks them once the block that lists them has run.
    if (OPTION_READING_BLOCK_TYPES.has(block.type)) {
      const optionErrors = this.outputOptionErrors(block.id)
      if (optionErrors.length > 0) {
        result.passed = false
        result.actualStatus = "error"
        result.error =
          "Input validation failed:\n" + optionErrors.map((error) => `  - ${error}`).join("\n")
        result.duration = Date.now() - start
        return result
      }
    }

    switch (block.type) {
      case "TemplateInline": {
        const tmpl = this.templateInlines.get(block.id)
        if (!tmpl) {
          result.passed = false
          result.actualStatus = "error"
          result.error = `TemplateInline block "${block.id}" not found`
          result.duration = Date.now() - start
          return result
        }
        return this.runTemplateInline(step, tmpl, start)
      }

      case "Template": {
        const tmpl = this.templates.get(block.id)
        if (!tmpl) {
          result.passed = false
          result.actualStatus = "error"
          result.error = `Template block "${block.id}" not found`
          result.duration = Date.now() - start
          return result
        }
        return this.runTemplate(step, tmpl, start)
      }

      case "Check":
      case "Command":
        return this.runCheckOrCommand(block, step, start)

      // A <Finish> runs its final check like a <Check>. Without one there is
      // nothing to run: finishing the runbook is the whole block, as in the app,
      // where it also counts as a successful run for the blocks that depend on it.
      case "Finish":
        if (!stringProp(block.props, "command") && !stringProp(block.props, "path")) {
          result.actualStatus = "success"
          result.passed = this.matchesExpectedStatus(step.expect, "success")
          this.scriptResults.set(normalizeBlockId(block.id), "success")
          result.duration = Date.now() - start
          if (this.options.verbose) console.log("  (no final check to run)")
          return result
        }
        return this.runCheckOrCommand(block, step, start)

      case "Prerequisites":
        return this.runPrerequisites(block, step, start)

      case "GitHubAuth":
        return this.runGitAuth(block, step, start, "github")

      case "GitLabAuth":
        return this.runGitAuth(block, step, start, "gitlab")

      case "GitAuth": {
        const provider = stringProp(block.props, "provider") || "github"
        if (provider !== "github" && provider !== "gitlab") {
          result.passed = false
          result.actualStatus = "error"
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

      case "AzureAuth":
        return this.runAzureAuth(block, step, start)

      case "GitClone":
        return this.runGitClone(block, step, start)

      case "Iframe":
        return this.runIframe(block, step, start)

      // `expect: skip` returned above, so any expectation that gets here would
      // need the block to push a branch and open a real pull request.
      case "GitPullRequest":
      case "GitHubPullRequest":
      case "GitLabMergeRequest":
        result.passed = false
        result.actualStatus = "error"
        result.error =
          "PR blocks can only be tested with expect: skip (test mode never opens a pull request)"
        result.duration = Date.now() - start
        return result

      case "SQLite":
        return this.runSQLite(block, step, start)

      default:
        result.passed = false
        result.actualStatus = "error"
        result.error = `Unsupported block type "${block.type}"`
        result.duration = Date.now() - start
        return result
    }
  }

  // -----------------------------------------------------------------------
  // Check / Command block
  // -----------------------------------------------------------------------

  private runCheckOrCommand(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`${lowercaseFirst(block.type)}:${block.id}`, step.expect)

    // Find the executable by component ID
    let foundExec: Executable | undefined
    const allExecs = this.registry.getAllExecutables()
    for (const [id, entry] of Object.entries(allExecs)) {
      if (entry.componentId === block.id) {
        foundExec = this.registry.getExecutableSync(id)
        break
      }
    }

    if (!foundExec) {
      result.passed = false
      result.actualStatus = "error"
      result.error = `Block "${block.id}" not found in runbook`
      result.duration = Date.now() - start
      return result
    }

    // A new attempt replaces the last one's outputs: until it succeeds or
    // warns, the block has none, so nothing reads a stale value
    this.blockOutputs.delete(block.id)

    // Render template vars in script content, and the block's env with the
    // same values
    let scriptContent = foundExec.content
    const blockEnv: Record<string, string> = {}
    try {
      const vars = this.buildTemplateVars(block.id)
      scriptContent = renderGoTemplate(scriptContent, vars)
      for (const [name, template] of Object.entries(foundExec.env)) {
        try {
          blockEnv[name] = renderGoTemplate(template, vars)
        } catch (e: unknown) {
          throw new Error(`${name} in env: ${errorMessage(e)}`, { cause: e })
        }
      }
    } catch (e: unknown) {
      result.passed = false
      result.actualStatus = "error"
      result.error = `Failed to render template: ${errorMessage(e)}`
      result.duration = Date.now() - start
      return result
    }

    // Create temp files for outputs and file capture
    const outputFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "runbook-output-")),
      "output.txt",
    )
    fs.writeFileSync(outputFile, "")
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-files-"))
    // The log files, as in the app: RUNBOOK_LOG, which the log_* helpers
    // append to, and one per level (RUNBOOK_INFO_LOG etc.)
    const logChannelDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-log-channels-"))
    const scriptLog = logChannelFiles(logChannelDir, [RUNBOOK_LOG_CHANNEL])[0]!
    const levelLogs = logChannelFiles(logChannelDir, LEVEL_LOG_CHANNELS)
    for (const { path: logFile } of [scriptLog, ...levelLogs]) fs.writeFileSync(logFile, "")
    // Made below; declared here so the finally can remove them
    let envDir = ""
    let pwdDir = ""
    let scriptDir = ""

    try {
      // Prepare the script
      const {
        interpreter,
        args: interpreterArgs,
        wrap: isBash,
      } = resolveScriptRunner(scriptContent, foundExec.language)

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

      // Build environment. The per-block vars go on last, as in the app.
      const env = this.sessionEnvWithTestEnv()
      env["RUNBOOK_OUTPUT"] = outputFile
      env["GENERATED_FILES"] = filesDir
      if (this.activeWorkTreePath) env["REPO_FILES"] = this.activeWorkTreePath
      for (const { envVar, path: logFile } of [scriptLog, ...levelLogs]) env[envVar] = logFile

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

      // Then the block's env, as data, as in the app
      Object.assign(env, blockEnv)

      // Run the script. spawnSync returns only once the script has exited, so
      // it can't order stdout, stderr and the log files by arrival the way
      // the app does. Instead the script's stdout and stderr append to
      // RUNBOOK_LOG, the file the log_* helpers append to: every write lands
      // at the end of the one file, so the logs keep the order the script
      // wrote them in. (Unlike in the app, a script that reads RUNBOOK_LOG
      // back sees its own output there too.)
      const args = [...interpreterArgs, scriptPath]
      const outputFd = fs.openSync(scriptLog.path, "a")
      let proc: ReturnType<typeof spawnSync>
      try {
        proc = spawnSync(interpreter, args, {
          cwd: this.sessionWorkDir,
          env,
          timeout: this.options.timeout,
          stdio: ["pipe", outputFd, outputFd],
        })
      } finally {
        fs.closeSync(outputFd)
      }

      const readLog = (logFile: string) => {
        try {
          return fs.readFileSync(logFile, "utf-8")
        } catch {
          return "" // the script removed it
        }
      }
      // The per-level files' lines follow, tagged with their level and
      // ordered by time (see orderLogChannelLines).
      const levelLogLines = orderLogChannelLines(
        levelLogs.map(({ level, path: logFile }) => {
          const text = readLog(logFile)
          try {
            return { level, text, lastWritten: fs.statSync(logFile).mtime }
          } catch {
            return { level, text }
          }
        }),
      )
      let logs = readLog(scriptLog.path)
      if (levelLogLines.length > 0) {
        if (logs !== "" && !logs.endsWith("\n")) logs += "\n"
        logs += levelLogLines.join("\n") + "\n"
      }
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

      this.scriptResults.set(
        normalizeBlockId(block.id),
        status === "success" || status === "warn" ? status : "fail",
      )

      // Parse outputs. Sensitive ones come back Redacted: later blocks'
      // templates and assertions reveal them, and printing them shows <redacted>.
      if (status === "success" || status === "warn") {
        try {
          result.outputs = parseBlockOutputsContent(fs.readFileSync(outputFile, "utf-8"))
        } catch {
          /* no outputs */
        }

        // Carry the script's exports and final cwd into later blocks
        if (isBash) this.applyEnvCapture(envCapturePath, pwdCapturePath, blockEnv)

        // Copy captured files to output directory
        this.creditGeneratedFiles(block.id, this.captureFiles(filesDir, this.resolveOutputPath()))
      }

      if (this.options.verbose) {
        this.printBlockOutput(block.id, logs, result.outputs, status, result.error)
      }

      // Store outputs
      if (Object.keys(result.outputs).length > 0) {
        this.blockOutputs.set(block.id, new Map(Object.entries(result.outputs)))
      }

      result.passed = this.matchesExpectedStatus(step.expect, status)
      result.duration = Date.now() - start
      return result
    } finally {
      // Cleanup temp files. The env capture holds every variable the script
      // saw, credentials included, so it must not outlive the block.
      for (const dir of [
        path.dirname(outputFile),
        filesDir,
        logChannelDir,
        envDir,
        pwdDir,
        scriptDir,
      ]) {
        if (dir)
          try {
            fs.rmSync(dir, { recursive: true, force: true })
          } catch {}
      }
    }
  }

  // -----------------------------------------------------------------------
  // Prerequisites block
  // -----------------------------------------------------------------------

  /**
   * Check a <Prerequisites> block's tools as the app does: bash looks each one
   * up on the session's PATH, and runs the ones whose version the block
   * reads. Unlike the app, a missing tool doesn't make it read PATH again: a
   * test has the PATH it was started with.
   */
  private runPrerequisites(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`${lowercaseFirst(block.type)}:${block.id}`, step.expect)

    // Validation reports a block without a valid tool list before any block runs.
    const toolList = extractToolList(block.content)
    const parsed = toolList === null ? null : parsePrerequisitesSpec(toolList)
    if (!parsed?.ok) {
      result.passed = false
      result.actualStatus = "error"
      result.error = parsed ? parsed.error : "The block has no tool list"
      result.duration = Date.now() - start
      return result
    }

    const env = this.sessionEnvWithTestEnv()
    const bash = (args: string[], timeoutMs: number) => {
      const proc = spawnSync("bash", args, {
        cwd: this.sessionWorkDir,
        env,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      let failure: RunFailure | null = null
      if (proc.error) {
        failure =
          (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
            ? { reason: "timeout", timeoutMs }
            : { reason: "error", cause: proc.error }
      }
      return { output: proc.stdout ?? "", exitCode: proc.status ?? -1, failure }
    }

    const { tools } = parsed.spec
    let status: PrerequisitesStatus = "fail"
    let log: LogEntry[]
    const lookup = bash(lookupArgs(tools.map((tool) => tool.name)), LOOKUP_TIMEOUT_MS)
    if (lookup.failure) {
      log = [lookupFailedLog(lookup.failure)]
    } else {
      const paths = parseLookupOutput(lookup.output.split("\n"))
      const checked = tools.map((tool) => {
        const toolPath = paths.get(tool.name) ?? null
        if (!toolPath || !tool.versionArgs) return checkTool(tool, toolPath, null)
        const probe = bash(probeArgs(toolPath, tool.versionArgs), PROBE_TIMEOUT_MS)
        return checkTool(
          tool,
          toolPath,
          probe.failure ?? { output: probe.output, exitCode: probe.exitCode },
        )
      })
      const toolResults = checked.map((checkedTool) => checkedTool.result)
      status = prerequisitesStatus(parsed.spec, toolResults)
      log = checkLog(parsed.spec, checked)
      // As in the app, only a check that passes or warns publishes its outputs.
      if (status !== "fail") result.outputs = prerequisitesOutputs(toolResults)
    }

    const at = new Date()
    const logs = log.map(({ level, text }) => `${tagLogLine(text, level, at)}\n`).join("")
    result.actualStatus = status
    result.exitCode = statusExitCode(status)
    result.logs = logs

    this.scriptResults.set(normalizeBlockId(block.id), status)
    if (status === "fail") {
      this.blockOutputs.delete(block.id)
    } else {
      this.blockOutputs.set(block.id, new Map(Object.entries(result.outputs)))
    }

    if (this.options.verbose) {
      this.printBlockOutput(block.id, logs, result.outputs, status, result.error)
    }

    result.passed = this.matchesExpectedStatus(step.expect, status)
    result.duration = Date.now() - start
    return result
  }

  /**
   * Apply a bash block's env/pwd capture the way the app's session does after
   * a successful run: the captured env, minus shell internals and per-block
   * vars like RUNBOOK_OUTPUT, replaces the session env, and a non-empty pwd
   * becomes the cwd for later blocks. A variable of the block's env (`blockEnv`,
   * as the script got it) stays the block's unless the script changed it: the
   * session keeps the value it had.
   */
  private applyEnvCapture(
    envCapturePath: string,
    pwdCapturePath: string,
    blockEnv: Record<string, string>,
  ): void {
    let env: Record<string, string> | undefined
    try {
      env = parseEnvCaptureContent(fs.readFileSync(envCapturePath, "utf-8"))
    } catch {
      /* nothing captured */
    }
    if (!env) return

    const captured = filterCapturedEnv(env)
    const before = envListToRecord(this.sessionEnv)
    for (const [name, value] of Object.entries(blockEnv)) {
      if (captured[name] !== value) continue
      if (Object.hasOwn(before, name)) captured[name] = before[name]!
      else delete captured[name]
    }
    this.sessionEnv = Object.entries(captured).map(([k, v]) => `${k}=${v}`)

    let pwd = ""
    try {
      pwd = fs.readFileSync(pwdCapturePath, "utf-8").trim()
    } catch {
      /* keep the current cwd */
    }
    if (pwd) this.sessionWorkDir = pwd
  }

  // -----------------------------------------------------------------------
  // TemplateInline block
  // -----------------------------------------------------------------------

  private runTemplateInline(step: TestStep, block: TemplateInlineBlock, start: number): StepResult {
    const result = makeStepResult(step.block, step.expect)

    // Render the template. The real values decide whether it renders and go
    // into the file generateFile writes; what the CLI logs and prints shows a
    // sensitive output as <redacted> instead.
    let rendered: string
    try {
      rendered = renderGoTemplate(block.content, this.buildTemplateVars(block.id))
    } catch (e: unknown) {
      result.passed = false
      result.actualStatus = "error"
      result.error = `${errorMessage(e)}`
      result.duration = Date.now() - start
      return result
    }

    // The masked context has the same keys, so this renders whenever the real one does
    const shown = this.redactSensitiveInputs(
      renderGoTemplate(block.content, this.buildTemplateVars(block.id, maskOutputs)),
    )

    // Write file if generateFile is set
    if (block.generateFile && block.outputPath) {
      let outputDir: string
      if (block.target === "worktree") {
        if (!this.activeWorkTreePath) {
          result.passed = false
          result.actualStatus = "error"
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
        result.passed = false
        result.actualStatus = "error"
        result.error = `Failed to write file: ${errorMessage(e)}`
        result.duration = Date.now() - start
        return result
      }
    }

    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.actualStatus = "success"
    result.logs = shown
    result.duration = Date.now() - start

    if (this.options.verbose) {
      console.log("--- Rendered Output ---")
      const lines = shown.split("\n")
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
        result.passed = false
        result.actualStatus = "error"
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
      const { inputs, outputs } = this.buildTemplateVars(block.id)
      // As in the app, every input is also at the top level ({{ .config_name }}),
      // whether the Template declares it or imports it. The two namespaces
      // win over an input with the same name.
      const vars = { ...inputs, inputs, outputs }
      this.creditGeneratedFiles(block.id, this.renderTemplateDir(templatePath, outputDir, vars))
    } catch (e: unknown) {
      result.passed = false
      result.actualStatus = "error"
      result.error = `Template rendering failed: ${errorMessage(e)}`
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
    const lookup =
      provider === "gitlab"
        ? this.findGitLabAuthEnv(block, prefix)
        : this.findGitHubAuthEnv(block, prefix)

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

  /**
   * GitHub token lookup for the block's `host` (github.com, GHES, or a
   * ghe.com tenant). Env tokens are read with the app's own host binding
   * (githubEnvCredentialForHost), so a github.com token is never used for an
   * enterprise host.
   */
  private findGitHubAuthEnv(block: ParsedComponent, prefix: string): GitAuthLookup {
    const host = tryNormalizeGitHubHost(stringProp(block.props, "host")) ?? DEFAULT_GITHUB_HOST
    const env = { ...process.env, ...this.testEnv }
    let token = githubEnvCredentialForHost(host, env, prefix)?.token ?? ""
    if (!prefix && host === DEFAULT_GITHUB_HOST) {
      token = this.getenv("RUNBOOKS_GITHUB_TOKEN") || token
    }
    if (!token) return { skipReason: "No GitHub credentials found" }
    return { token, vars: { GITHUB_TOKEN: token, GITHUB_HOST: host } }
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
    const pinned = stringProp(block.props, "instanceUrl") || stringProp(block.props, "host")
    // Not normalizeGitLabHost: its gitlab.com fallback would bind a typo'd pin
    // to gitlab.com and hand the block a gitlab.com token.
    const host = pinned ? tryNormalizeGitLabHost(pinned) : envTokenHost(env)
    if (pinned && !host) {
      return { skipReason: `"${pinned}" is not a valid GitLab instance URL or host` }
    }
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
        (e) =>
          !e.startsWith("AWS_ACCESS_KEY_ID=") &&
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
      stringProp(block.props, "project")
    const region =
      this.firstEnv(prefix, GOOGLE_REGION_ENV_VARS) ||
      (prefix ? this.firstEnv("", GOOGLE_REGION_ENV_VARS) : "") ||
      stringProp(block.props, "defaultRegion")
    const zone =
      this.firstEnv(prefix, GOOGLE_ZONE_ENV_VARS) ||
      (prefix ? this.firstEnv("", GOOGLE_ZONE_ENV_VARS) : "") ||
      stringProp(block.props, "defaultZone")

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
  // AzureAuth block
  // -----------------------------------------------------------------------

  private findAzureServicePrincipal(prefix: string) {
    for (const family of ["ARM_", "AZURE_"]) {
      const get = (name: string) => this.getenv(`${prefix}${family}${name}`)
      const clientId = get("CLIENT_ID")
      const tenantId = get("TENANT_ID")
      const clientSecret = get("CLIENT_SECRET")
      const certPath = get("CLIENT_CERTIFICATE_PATH")
      const certificatePath = /\.(pfx|p12)$/i.test(certPath) ? "" : certPath
      if (clientId && tenantId && (clientSecret || certificatePath)) {
        return {
          clientId,
          tenantId,
          clientSecret,
          certificatePath,
          subscriptionId: get("SUBSCRIPTION_ID"),
        }
      }
    }
    return null
  }

  private resolveAzureCliDir(): string | null {
    const dir = this.hasEnv("AZURE_CONFIG_DIR")
      ? this.getenv("AZURE_CONFIG_DIR")
      : path.join(os.homedir(), ".azure")
    if (!dir) return null
    return fs.existsSync(path.join(dir, "azureProfile.json")) ? dir : null
  }

  private readAzureCliDefault(dir: string): { tenantId?: string; subscriptionId?: string } {
    try {
      const text = fs
        .readFileSync(path.join(dir, "azureProfile.json"), "utf8")
        .replace(/^\uFEFF/, "")
      const profile = JSON.parse(text) as {
        subscriptions?: Array<{
          id?: string
          tenantId?: string
          name?: string
          isDefault?: boolean
        }>
      }
      const account = profile.subscriptions?.find((sub) => sub.isDefault)
      if (!account?.tenantId) return {}
      const tenantLevel =
        account.id === account.tenantId || account.name === "N/A(tenant level account)"
      return {
        tenantId: account.tenantId,
        ...(account.id && !tenantLevel ? { subscriptionId: account.id } : {}),
      }
    } catch {
      return {}
    }
  }

  private runAzureAuth(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`azureAuth:${block.id}`, step.expect)
    const prefix = step.env_prefix ?? ""
    const creds: Record<string, string> = {}

    const sp =
      this.findAzureServicePrincipal(prefix) ?? (prefix ? this.findAzureServicePrincipal("") : null)
    const cliDir = sp ? null : this.resolveAzureCliDir()

    if (!sp && !cliDir) {
      this.blockStates.set(block.id, "skipped")
      result.actualStatus = "skipped"
      result.passed = this.matchesExpectedStatus(step.expect, "skipped")
      result.duration = Date.now() - start
      if (this.options.verbose) console.log("--- No Azure credentials found ---")
      return result
    }

    const cliDefault = cliDir ? this.readAzureCliDefault(cliDir) : {}
    const envTenant =
      this.firstEnv(prefix, ["ARM_TENANT_ID", "AZURE_TENANT_ID"]) ||
      this.firstEnv("", ["ARM_TENANT_ID", "AZURE_TENANT_ID"])
    const tenantId =
      sp?.tenantId || stringProp(block.props, "tenantId") || envTenant || cliDefault.tenantId
    const subscriptionId =
      stringProp(block.props, "subscriptionId") ||
      sp?.subscriptionId ||
      this.firstEnv(prefix, ["ARM_SUBSCRIPTION_ID", "AZURE_SUBSCRIPTION_ID"]) ||
      this.firstEnv("", ["ARM_SUBSCRIPTION_ID", "AZURE_SUBSCRIPTION_ID"]) ||
      cliDefault.subscriptionId

    if (sp) {
      creds["AZURE_AUTH_TYPE"] = "service_principal"
      creds["ARM_CLIENT_ID"] = sp.clientId
      creds["AZURE_CLIENT_ID"] = sp.clientId
      creds["AZURE_PRINCIPAL_NAME"] = sp.clientId
      creds["AZURE_PRINCIPAL_TYPE"] = "servicePrincipal"
      if (sp.clientSecret) {
        creds["ARM_CLIENT_SECRET"] = sp.clientSecret
        creds["AZURE_CLIENT_SECRET"] = sp.clientSecret
      } else {
        creds["AZURE_CLIENT_CERTIFICATE_PATH"] = sp.certificatePath
        creds["ARM_USE_CLI"] = "true"
      }
    } else if (cliDir) {
      creds["AZURE_AUTH_TYPE"] = "cli"
      creds["AZURE_CONFIG_DIR"] = cliDir
      creds["ARM_USE_CLI"] = "true"
    }
    if (tenantId) {
      creds["AZURE_TENANT_ID"] = tenantId
      // Same rule as azureSessionEnv: no ARM_TENANT_ID with the CLI's sign-in
      if (creds["ARM_USE_CLI"] !== "true") creds["ARM_TENANT_ID"] = tenantId
    }
    if (subscriptionId) {
      creds["ARM_SUBSCRIPTION_ID"] = subscriptionId
      creds["AZURE_SUBSCRIPTION_ID"] = subscriptionId
    }

    this.authBlockCredentials.set(block.id, creds)

    const stale = new Set<string>(AZURE_AUTH_ENV_VARS)
    this.sessionEnv = this.sessionEnv.filter((entry) => {
      const eq = entry.indexOf("=")
      return eq === -1 || !stale.has(entry.slice(0, eq))
    })
    for (const [k, v] of Object.entries(creds)) this.sessionEnv.push(`${k}=${v}`)

    this.blockStates.set(block.id, "success")
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.duration = Date.now() - start
    if (this.options.verbose) console.log("--- Azure credentials found, injected ---")
    return result
  }

  // -----------------------------------------------------------------------
  // GitClone block
  // -----------------------------------------------------------------------

  /**
   * Stand in for the page an Iframe block frames. The test can't run a page,
   * so the step's set_outputs become the block's outputs, as if the page had
   * set them. Like the app, it refuses names the block's outputs prop doesn't
   * list.
   */
  private runIframe(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`iframe:${block.id}`, step.expect)
    const values = step.set_outputs ?? {}
    const declared = stringArrayProp(block.props, "outputs") ?? []
    const undeclared = Object.keys(values).filter((name) => !declared.includes(name))
    if (undeclared.length > 0) {
      result.passed = false
      result.actualStatus = "error"
      result.error = `set_outputs names outputs the block's outputs prop doesn't list: ${undeclared.join(", ")}`
      result.duration = Date.now() - start
      return result
    }

    result.outputs = { ...values }
    if (Object.keys(values).length > 0) {
      this.blockOutputs.set(block.id, new Map(Object.entries(values)))
    }
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success")
    result.duration = Date.now() - start
    return result
  }

  // -----------------------------------------------------------------------
  // SQLite block
  // -----------------------------------------------------------------------

  private runSQLite(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`sqlite:${block.id}`, step.expect)

    const dbProp = stringProp(block.props, "db")
    const query = stringProp(block.props, "query")
    const pathProp = stringProp(block.props, "path")
    if (!dbProp || (!query && !pathProp)) {
      result.passed = false
      result.actualStatus = "config_error"
      result.error = `SQLite block "${block.id}" requires 'db' and one of 'query' or 'path'`
      result.duration = Date.now() - start
      return result
    }
    if (query && pathProp) {
      result.passed = false
      result.actualStatus = "config_error"
      result.error = `SQLite block "${block.id}" takes either 'query' or 'path', not both`
      result.duration = Date.now() - start
      return result
    }

    // Resolve the db path against the runbook's folder, as the app's
    // path-guard does (resolveAgainstRunbook). `:memory:` stays as-is.
    const runbookDir = path.dirname(this.runbookPath)
    const dbPath = dbProp === ":memory:" ? ":memory:" : path.resolve(runbookDir, dbProp)

    // Read params prop (array of scalars)
    const rawParams = block.props.params
    const params: SqlParam[] = Array.isArray(rawParams)
      ? rawParams.map((p) => {
          if (p === null) return null
          if (typeof p === "string" || typeof p === "number" || typeof p === "boolean") return p
          return String(p)
        })
      : []

    const db = openSqliteDatabase(dbPath)
    try {
      let queryResult: SqlQueryResult
      try {
        if (pathProp) {
          // Like a Command's `path`: relative to the runbook's folder, as in the app.
          const sqlPath = path.resolve(runbookDir, pathProp)
          const sql = fs.readFileSync(sqlPath, "utf8")
          queryResult = Effect.runSync(runSqlScript(db, sql))
        } else {
          queryResult = Effect.runSync(runQuery(db, query ?? "", params))
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        result.actualStatus = "fail"
        result.passed = this.matchesExpectedStatus(step.expect, "fail")
        if (step.error_contains && !msg.toLowerCase().includes(step.error_contains.toLowerCase())) {
          result.passed = false
          result.error = `Expected error to contain "${step.error_contains}" but got: ${msg}`
        }
        result.duration = Date.now() - start
        return result
      }
      result.actualStatus = "success"
      result.passed = this.matchesExpectedStatus(step.expect, "success")
      // Publish the output prop as a JSON-encoded rows array, as the app does
      const outputName = stringProp(block.props, "output")
      if (outputName) {
        result.outputs = { [outputName]: JSON.stringify(queryResult.rows) }
        this.blockOutputs.set(block.id, new Map([[outputName, JSON.stringify(queryResult.rows)]]))
      }
      this.passedScripts.add(normalizeBlockId(block.id))
    } finally {
      db.close()
    }
    result.duration = Date.now() - start
    return result
  }

  private runGitClone(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result = makeStepResult(`gitClone:${block.id}`, step.expect)

    // A block pointed at an existing checkout clones nothing — it just adopts
    // the directory, mirroring the app's "Use local checkout" source.
    const repoDir = stringProp(block.props, "prefilledRepoDir")
    const source = stringProp(block.props, "source")
    if (source === "local" || (!source && repoDir)) {
      return this.runGitCloneLocal(block, step, start, result, repoDir)
    }

    const cloneURL = stringProp(block.props, "prefilledUrl")
    const ref = stringProp(block.props, "prefilledRef")
    const repoPath = stringProp(block.props, "prefilledRepoPath")
    const localPath = stringProp(block.props, "prefilledLocalPath")

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

    // Authenticate an https clone with a token that belongs to the URL's host
    // (cloneAuthEnv). The token goes in the git commands' environment
    // (withGitHttpAuth), never in the clone URL, so it is not saved to the
    // checkout's .git/config.
    const cloneEnv = this.cloneAuthEnv(block, cloneURL)

    if (this.options.verbose) {
      console.log(`--- Cloning ${cloneURL} ---`)
      if (ref) console.log(`  Ref: ${ref}`)
      console.log(`  Destination: ${destPath}`)
    }

    // The same git commands the app runs, so a sparse clone (with or without
    // a ref) behaves identically here.
    const cloneSteps = buildCloneSteps(cloneURL, destPath, { ref, repoPath })
    if (Result.isFailure(cloneSteps)) {
      result.passed = this.matchesExpectedStatus(step.expect, "fail")
      result.actualStatus = "fail"
      result.error = cloneSteps.failure.stderr
      result.duration = Date.now() - start
      return result
    }

    try {
      // The ref goes to git as the value of `--branch`, which consumes it
      // whatever it looks like. git won't create a branch or tag whose name
      // begins with `-`, so refuse one up front with a clear message rather
      // than let the clone fail on a branch that can't exist.
      if (ref?.startsWith("-")) {
        throw new Error(`Invalid ref "${ref}": a git ref cannot begin with "-"`)
      }

      for (const gitStep of cloneSteps.success) {
        // A repository with no commits has nothing to check out, as in the app.
        if (gitStep.skipIfNoCommits && !hasCommits(destPath, cloneEnv)) continue
        // Every step gets the clone's auth: a sparse clone is blobless, so its
        // checkout fetches file contents lazily from origin.
        execFileSync("git", gitStep.args, {
          timeout: this.options.timeout,
          stdio: "pipe",
          env: cloneEnv,
        })
      }
    } catch (e: unknown) {
      result.passed = this.matchesExpectedStatus(step.expect, "fail")
      result.actualStatus = "fail"
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
   * The environment for an https clone's git commands, carrying a token only
   * when one belongs to the clone URL's host, as main's clone handler does.
   * The provider comes from the auth block the GitClone references with
   * `gitAuthId` or `githubAuthId`, or, with no reference, from the URL's host
   * (a github.com-family host or gitlab.com). The token is that auth block's
   * when the block authenticated the URL's host, otherwise the session env's
   * with the app's host binding (githubSessionCredential,
   * gitlabSessionTokenHost). The test's `env` goes on top of the session env,
   * as for any Command, so a test can blank an ambient token. GitLab takes the
   * token as user `oauth2`, GitHub as `x-access-token`. Only https URLs get a
   * token; SSH authenticates itself.
   */
  private cloneAuthEnv(block: ParsedComponent, cloneURL: string): NodeJS.ProcessEnv {
    let url: URL
    try {
      url = new URL(cloneURL)
    } catch {
      return process.env
    }
    if (url.protocol !== "https:") return process.env
    const host = url.host.toLowerCase()

    const authId = stringProp(block.props, "gitAuthId") || stringProp(block.props, "githubAuthId")
    const provider: GitProvider | undefined =
      (authId ? this.gitAuthTokens.get(authId)?.provider : undefined) ??
      (host === "gitlab.com" ? "gitlab" : isGitHubHost(host) ? "github" : undefined)
    if (!provider) return process.env

    const creds = authId ? this.authBlockCredentials.get(authId) : undefined
    const session = this.sessionEnvWithTestEnv()
    let token = ""
    if (provider === "github") {
      const cloneHost = tryNormalizeGitHubHost(cloneURL)
      if (!cloneHost) return process.env
      if (creds && (creds["GITHUB_HOST"] ?? DEFAULT_GITHUB_HOST) === cloneHost) {
        token = creds["GITHUB_TOKEN"] ?? ""
      }
      if (!token) {
        token =
          githubSessionCredential(session, cloneHost, tryNormalizeGitHubHost(session.GITHUB_HOST))
            ?.token ?? ""
      }
    } else {
      if (creds && creds["GITLAB_HOST"] === host) token = creds["GITLAB_TOKEN"] ?? ""
      if (!token && gitlabSessionTokenHost(session) === host) token = session["GITLAB_TOKEN"] ?? ""
    }
    if (!token) return process.env

    // No terminal prompt: a rejected token must fail the step, not wait for a
    // username on the TTY until the step times out.
    return withGitHttpAuth(
      { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      cloneURL,
      token,
      gitCredentialUsername(provider),
    )
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

  /**
   * The value of every Inputs and Template variable that `set` (the test's
   * inputs) leaves out, as the app's form starts it: its default, else what
   * its control shows (false for a bool, the displayed elements for a tuple).
   * A Template variable that a block it imports with inputsId also declares is
   * read-only in the app and shows the imported value (from the last of those
   * blocks that has one), so it starts from that value instead.
   */
  private fillUnsetInputs(set: Record<string, unknown>): Record<string, unknown> {
    const schemas = this.validator.getAllSchemas()
    const filled: Record<string, unknown> = {}
    const pending = new Set<string>()

    const valueOf = (blockId: string, varName: string): unknown => {
      const key = `${blockId}.${varName}`
      if (key in set) return set[key]
      if (key in filled) return filled[key]
      const variable = schemas.get(blockId)?.variables.get(varName)
      // pending: an inputsId cycle between Templates imports nothing.
      if (!variable || pending.has(key)) return undefined

      pending.add(key)
      let imported: unknown
      for (const id of this.templates.get(blockId)?.inputsIds ?? []) {
        imported = valueOf(id, varName) ?? imported
      }
      pending.delete(key)

      const value = imported ?? variable.default ?? untouchedValue(variable)
      if (value !== undefined) filled[key] = value
      return value
    }

    for (const [blockId, schema] of schemas) {
      for (const varName of schema.variables.keys()) valueOf(blockId, varName)
    }
    return filled
  }

  /**
   * Problems with the inputs block `blockId` reads (those of the blocks it
   * imports, in turn) whose options come from a block's output: an output
   * that isn't a list of options, or a value that isn't one of them. As
   * `<input key>: <message>`.
   */
  private outputOptionErrors(blockId: string): string[] {
    const schemas = this.validator.getAllSchemas()
    const outputs = this.templateOutputs()
    const errors: string[] = []
    const seen = new Set<string>()
    const visit = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      for (const importedId of this.templates.get(id)?.inputsIds ?? []) visit(importedId)
      for (const [name, variable] of schemas.get(id)?.variables ?? []) {
        const reference = variable.optionsFrom
        if (!reference) continue
        const key = `${id}.${name}`
        const output = outputs[normalizeBlockId(reference.blockId)]?.[reference.outputName]
        const parsed = parseOutputOptions(reference, output)
        if (!parsed.ok) {
          errors.push(`${key}: ${parsed.error}`)
          continue
        }
        const resolved = { ...variable, ...optionFields(parsed.items) }
        const error = optionMembershipError(resolved, this.testInputs[key])
        if (error) errors.push(`${key}: ${error}`)
      }
    }
    for (const id of this.inputsIds.get(blockId) ?? []) visit(id)
    return errors
  }

  /**
   * The template data context of block `blockId`. Its `.inputs` holds the
   * values of the blocks it reads them from (inputsIdsOf), merged in order
   * with a later block's value winning, as the app merges them, so a variable
   * of a block it doesn't import never reaches it. Outputs get their real
   * values by default, for what a block runs or writes; pass maskOutputs for
   * what is only shown, so a sensitive output renders as <redacted>.
   */
  private buildTemplateVars(
    blockId: string,
    outputValues: (values: OutputValues) => Record<string, string> = revealOutputs,
  ): { inputs: Record<string, unknown>; outputs: Record<string, Record<string, string>> } {
    const inputs: Record<string, unknown> = {}
    for (const id of this.inputsIds.get(blockId) ?? []) {
      Object.assign(inputs, this.registeredInputs(id))
    }
    return { inputs, outputs: this.templateOutputs(outputValues) }
  }

  /**
   * The values block `id` gives a block that imports it, by variable name, as
   * the app registers them: an Inputs block's variables, or a Template's on
   * top of the values of the blocks it imports in turn. A Template that is
   * already being resolved (an inputsId cycle) imports nothing more.
   */
  private registeredInputs(id: string, resolving = new Set<string>()): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    const tmpl = this.templates.get(id)
    if (tmpl && !resolving.has(id)) {
      resolving.add(id)
      for (const importedId of tmpl.inputsIds) {
        Object.assign(values, this.registeredInputs(importedId, resolving))
      }
      resolving.delete(id)
    }
    for (const [key, value] of Object.entries(this.testInputs)) {
      const [inputsId, name] = key.split(".", 2)
      if (inputsId === id && name !== undefined) values[name] = value
    }
    return values
  }

  /**
   * Every block's outputs, keyed the way templates reference them: by block
   * ID with hyphens turned into underscores, so `outputs.create_account`
   * finds block "create-account".
   */
  private templateOutputs(
    outputValues: (values: OutputValues) => Record<string, string> = revealOutputs,
  ): Record<string, Record<string, string>> {
    const outputs: Record<string, Record<string, string>> = {}
    for (const [blockId, blockOutputs] of this.blockOutputs) {
      outputs[normalizeBlockId(blockId)] = outputValues(Object.fromEntries(blockOutputs))
    }
    return outputs
  }

  private matchesExpectedStatus(expected: ExpectedStatus, actual: string): boolean {
    switch (expected) {
      case "success":
        return actual === "success"
      case "fail":
        return actual === "fail"
      case "warn":
        return actual === "warn"
      case "blocked":
        return actual === "blocked"
      case "skip":
        return actual === "skipped"
      case "hidden":
        return actual === "hidden"
      case "config_error":
        return actual === "config_error"
      default:
        return false
    }
  }

  private checkMissingOutputs(expected: string[]): string[] {
    // Look outputs up the way templates reference them, so
    // `outputs.create_account.account_id` finds block "create-account"
    const templateOutputs = this.templateOutputs()
    const missing: string[] = []
    for (const p of expected) {
      const [root, rawBlockId, outputName] = p.split(".")
      if (root === "outputs" && rawBlockId !== undefined && outputName !== undefined) {
        const blockId = normalizeBlockId(rawBlockId)
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
      env: this.sessionEnvWithTestEnv(),
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
      const truncated =
        lines.length > maxLines
          ? [`... (${lines.length - maxLines} lines truncated) ...`, ...lines.slice(-maxLines)]
          : lines
      msg += `\n\n--- Script Output ---\n${truncated.join("\n")}`
    }

    return msg
  }

  private printBlockOutput(
    _blockId: string,
    logs: string,
    outputs: OutputValues,
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
        const shown = maskOutput(value)
        const display = shown.length > 100 ? shown.slice(0, 97) + "..." : shown
        console.log(`  ${key} = ${display}`)
      }
    }
    const icon = status === "success" || status === "warn" ? "✓" : "✗"
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
      const script =
        action.command ||
        fs.readFileSync(path.join(path.dirname(this.runbookPath), action.path!), "utf-8")
      const cwd = this.resolveOutputPath()
      fs.mkdirSync(cwd, { recursive: true })
      execFileSync("/bin/bash", ["-c", script], {
        cwd,
        env: this.sessionEnvWithTestEnv(),
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
  return errorMessage(e)
}

/** A block ID as templates name it, with hyphens turned into underscores. */
function normalizeBlockId(id: string): string {
  return id.replace(/-/g, "_")
}
