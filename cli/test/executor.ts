/**
 * Test execution engine.
 * Port of api/testing/executor.go.
 *
 * Runs runbook tests in headless mode — parses the MDX, executes blocks in
 * document order, captures outputs, and validates assertions.
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
  wrapBashScript,
} from "../../src/domain/exec/script.ts"
import type { Executable } from "../../src/types.ts"

import type {
  TestCase,
  TestStep,
  ExpectedStatus,
  TestResult,
  StepResult,
} from "./config.ts"
import { resolveTestInputs } from "./fuzz.ts"
import { runAssertion, type AssertionContext } from "./assertions.ts"
import {
  InputValidator,
  parseAuthDependencies,
  parseTemplateInlineBlocks,
  parseTemplateBlocks,
  type TemplateInlineBlock,
  type TemplateBlock,
  type AuthDependency,
} from "./validation.ts"
import type { ParsedComponent } from "../../src/domain/registry/executable.ts"

// ---------------------------------------------------------------------------
// Block types & states
// ---------------------------------------------------------------------------

type BlockState = "success" | "skipped"

const AUTH_BLOCK_TYPES = new Set(["AwsAuth", "GitHubAuth"])

function isAuthBlock(blockType: string): boolean {
  return AUTH_BLOCK_TYPES.has(blockType)
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

  // Per-session state
  private sessionEnv: string[] = []
  private sessionWorkDir: string

  // Per-test state (reset each test)
  private blockOutputs = new Map<string, Map<string, string>>()
  private testInputs: Record<string, unknown> = {}
  private testEnv: Record<string, string> = {}
  private blockStates = new Map<string, BlockState>()
  private authBlockCredentials = new Map<string, Record<string, string>>()
  private activeWorkTreePath = ""

  constructor(
    private runbookPath: string,
    private workingDir: string,
    private outputPath: string,
    private options: ExecutorOptions,
  ) {
    this.sessionWorkDir = workingDir
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
    this.sessionEnv = Object.entries(process.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
  }

  close(): void {
    // No-op for now; reserved for future cleanup
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

  // -----------------------------------------------------------------------
  // Run a test case
  // -----------------------------------------------------------------------

  runTest(tc: TestCase): TestResult {
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
    this.blockOutputs = new Map()
    this.blockStates = new Map()
    this.authBlockCredentials = new Map()
    this.activeWorkTreePath = ""

    // 3. Get all blocks in document order
    const allBlocks = this.validator.getComponents()

    // 4. Build step maps
    const expectsConfigError = new Set<string>()
    const stepsToRun = new Map<string, TestStep>()
    const hasExplicitSteps = (tc.steps?.length ?? 0) > 0

    for (const step of tc.steps ?? []) {
      if (step.expect === "config_error") expectsConfigError.add(step.block)
      stepsToRun.set(step.block, step)
    }

    const registryWarnings = this.registry.getWarnings()

    // 5. Process each block in document order
    for (const block of allBlocks) {
      const stepResult = this.processBlock(
        block, stepsToRun, expectsConfigError, registryWarnings, hasExplicitSteps,
      )
      result.stepResults.push(stepResult)

      if (!stepResult.passed) {
        const isRequested = stepsToRun.has(block.id) || !hasExplicitSteps
        if (isRequested) {
          result.status = "failed"
          result.error = this.formatBlockError(block, stepResult)
          break
        }
      }

      // Per-step assertions
      const step = stepsToRun.get(block.id)
      if (step?.assertions && stepResult.passed) {
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

    // Cleanup
    if (tc.cleanup) {
      for (const cleanup of tc.cleanup) {
        this.runCleanup(cleanup)
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
    stepsToRun: Map<string, TestStep>,
    expectsConfigError: Set<string>,
    registryWarnings: string[],
    hasExplicitSteps: boolean,
  ): StepResult {
    const start = Date.now()

    let step = stepsToRun.get(block.id)
    let shouldRun = stepsToRun.has(block.id)
    if (!hasExplicitSteps) {
      shouldRun = block.type !== "Inputs"
      step = step ?? { block: block.id, expect: "success" }
    }

    const result: StepResult = {
      block: `${lowercaseFirst(block.type)}:${block.id}`,
      expectedStatus: step?.expect ?? "success",
      actualStatus: "",
      exitCode: 0,
      passed: true,
      outputs: {},
      duration: 0,
      assertionResults: [],
    }

    // 1. Check for config errors
    const configError = this.getConfigErrorForBlock(block, registryWarnings)

    if (configError) {
      result.actualStatus = "config_error"
      result.error = configError

      const isRequested = stepsToRun.has(block.id) || !hasExplicitSteps

      if (expectsConfigError.has(block.id)) {
        if (step?.error_contains && !configError.toLowerCase().includes(step.error_contains.toLowerCase())) {
          result.passed = false
        } else {
          result.passed = true
        }
      } else if (!isRequested) {
        result.passed = true
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

    // 3. Skip non-requested blocks
    if (!shouldRun) {
      result.actualStatus = "skipped"
      result.passed = true
      result.duration = Date.now() - start
      return result
    }

    // 4. Check auth dependencies
    if (this.authDeps.has(block.id)) {
      const authDep = this.authDeps.get(block.id)!
      const authState = this.blockStates.get(authDep.authBlockId)

      if (authState === undefined) {
        result.passed = false
        result.actualStatus = "blocked"
        result.error = `Block depends on "${authDep.authBlockId}" which hasn't run yet`
        result.duration = Date.now() - start
        return result
      }

      if (authState === "skipped") {
        if (step?.expect === "skip") {
          result.passed = true
          result.actualStatus = "skipped"
          result.duration = Date.now() - start
          return result
        }
        result.passed = false
        result.actualStatus = "blocked"
        result.error = `Block depends on "${authDep.authBlockId}" which was skipped`
        result.duration = Date.now() - start
        return result
      }
    }

    // 5. Dispatch block
    return this.dispatchBlock(block, step!, start)
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
    const result: StepResult = {
      block: `${lowercaseFirst(block.type)}:${block.id}`,
      expectedStatus: step.expect,
      actualStatus: "",
      exitCode: 0,
      passed: true,
      outputs: {},
      duration: 0,
      assertionResults: [],
    }

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
        return this.runGitHubAuth(block, step, start)

      case "AwsAuth":
        return this.runAwsAuth(block, step, start)

      case "GitClone":
        return this.runGitClone(block, step, start)

      case "GitHubPullRequest":
        result.passed = (step.expect as string) === "skip"
        result.actualStatus = "skipped"
        result.duration = Date.now() - start
        if (this.options.verbose) console.log("  (GitHubPullRequest blocks are skipped in test mode)")
        return result

      case "Admonition":
        result.passed = true; result.actualStatus = "success"
        result.duration = Date.now() - start
        if (this.options.verbose) console.log("  (decorative block - no run)")
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
    const result: StepResult = {
      block: `${lowercaseFirst(block.type)}:${block.id}`,
      expectedStatus: step.expect,
      actualStatus: "",
      exitCode: 0,
      passed: true,
      outputs: {},
      duration: 0,
      assertionResults: [],
    }

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

    // Handle blocked expectation
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

    try {
      // Prepare the script
      const [interpreter, interpreterArgs] = detectInterpreter(scriptContent, foundExec.language)
      const isBash = isBashInterpreter(interpreter)

      let scriptToWrite = scriptContent
      let envCapturePath = ""
      let pwdCapturePath = ""

      if (isBash) {
        const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-env-"))
        envCapturePath = path.join(envDir, "env.txt")
        fs.writeFileSync(envCapturePath, "")
        const pwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-pwd-"))
        pwdCapturePath = path.join(pwdDir, "pwd.txt")
        fs.writeFileSync(pwdCapturePath, "")
        scriptToWrite = wrapBashScript(scriptContent, envCapturePath, pwdCapturePath)
      }

      const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-script-"))
      const scriptPath = path.join(scriptDir, "script.sh")
      fs.writeFileSync(scriptPath, scriptToWrite, { mode: 0o700 })

      // Build environment
      const env: Record<string, string> = {}
      for (const entry of this.sessionEnv) {
        const idx = entry.indexOf("=")
        if (idx >= 0) env[entry.slice(0, idx)] = entry.slice(idx + 1)
      }
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
          const outputContent = fs.readFileSync(outputFile, "utf-8")
          const outputs: Record<string, string> = {}
          for (const line of outputContent.split("\n")) {
            const idx = line.indexOf("=")
            if (idx >= 0) {
              outputs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
            }
          }
          result.outputs = outputs
        } catch { /* no outputs */ }

        // Copy captured files to output directory
        this.captureFiles(filesDir, this.resolveOutputPath())
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

      result.passed = this.matchesExpectedStatus(step.expect, status, exitCode)
      result.duration = Date.now() - start
      return result

    } finally {
      // Cleanup temp files
      try { fs.rmSync(path.dirname(outputFile), { recursive: true, force: true }) } catch {}
      try { fs.rmSync(filesDir, { recursive: true, force: true }) } catch {}
    }
  }

  // -----------------------------------------------------------------------
  // TemplateInline block
  // -----------------------------------------------------------------------

  private runTemplateInline(step: TestStep, block: TemplateInlineBlock, start: number): StepResult {
    const result: StepResult = {
      block: step.block,
      expectedStatus: step.expect,
      actualStatus: "",
      exitCode: 0,
      passed: true,
      outputs: {},
      duration: 0,
      assertionResults: [],
    }

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
        if (this.options.verbose) console.log(`--- Wrote file: ${outputFile} ---`)
      } catch (e: unknown) {
        result.passed = false; result.actualStatus = "error"
        result.error = `Failed to write file: ${e}`
        result.duration = Date.now() - start
        return result
      }
    }

    result.passed = this.matchesExpectedStatus(step.expect, "success", 0)
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
    const result: StepResult = {
      block: step.block,
      expectedStatus: step.expect,
      actualStatus: "",
      exitCode: 0,
      passed: true,
      outputs: {},
      duration: 0,
      assertionResults: [],
    }

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
      this.renderTemplateDir(templatePath, outputDir, vars)
    } catch (e: unknown) {
      result.passed = false; result.actualStatus = "error"
      result.error = `Template rendering failed: ${e}`
      result.duration = Date.now() - start
      return result
    }

    result.passed = this.matchesExpectedStatus(step.expect, "success", 0)
    result.actualStatus = "success"
    result.duration = Date.now() - start

    if (this.options.verbose) {
      console.log("--- Result: ✓ success ---")
    }

    return result
  }

  /**
   * Walk a template directory, render each file through Go template, and write
   * to the output directory. Skips `boilerplate.yml` and hidden files.
   */
  private renderTemplateDir(
    templateDir: string,
    outputDir: string,
    vars: Record<string, unknown>,
  ): void {
    const entries = fs.readdirSync(templateDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === "boilerplate.yml" || entry.name.startsWith(".")) continue

      const srcPath = path.join(templateDir, entry.name)
      const destPath = path.join(outputDir, entry.name)

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true })
        this.renderTemplateDir(srcPath, destPath, vars)
      } else {
        const content = fs.readFileSync(srcPath, "utf-8")
        const rendered = renderGoTemplate(content, vars)
        fs.writeFileSync(destPath, rendered)
      }
    }
  }

  // -----------------------------------------------------------------------
  // GitHubAuth block
  // -----------------------------------------------------------------------

  private runGitHubAuth(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result: StepResult = {
      block: `gitHubAuth:${block.id}`,
      expectedStatus: step.expect,
      actualStatus: "",
      exitCode: 0,
      passed: true,
      outputs: {},
      duration: 0,
      assertionResults: [],
    }

    const prefix = step.env_prefix ?? ""
    let token = ""

    if (prefix) {
      token = this.getenv(`${prefix}GITHUB_TOKEN`) || this.getenv(`${prefix}GH_TOKEN`)
    } else {
      token = this.getenv("RUNBOOKS_GITHUB_TOKEN") || this.getenv("GITHUB_TOKEN") || this.getenv("GH_TOKEN")
    }

    if (!token) {
      this.blockStates.set(block.id, "skipped")
      result.actualStatus = "skipped"
      result.passed = this.matchesExpectedStatus(step.expect, "skipped", 0)
      result.duration = Date.now() - start
      if (this.options.verbose) console.log("--- No GitHub credentials found ---")
      return result
    }

    const envVars: Record<string, string> = { GITHUB_TOKEN: token }
    this.authBlockCredentials.set(block.id, envVars)

    // Inject into session env
    this.sessionEnv = this.sessionEnv.filter((e) => !e.startsWith("GITHUB_TOKEN="))
    this.sessionEnv.push(`GITHUB_TOKEN=${token}`)

    this.blockStates.set(block.id, "success")
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success", 0)
    result.duration = Date.now() - start
    if (this.options.verbose) console.log("--- GitHub credentials found, injected ---")
    return result
  }

  // -----------------------------------------------------------------------
  // AwsAuth block
  // -----------------------------------------------------------------------

  private runAwsAuth(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result: StepResult = {
      block: `awsAuth:${block.id}`,
      expectedStatus: step.expect,
      actualStatus: "",
      exitCode: 0,
      passed: true,
      outputs: {},
      duration: 0,
      assertionResults: [],
    }

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
      result.passed = this.matchesExpectedStatus(step.expect, "skipped", 0)
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
    result.passed = this.matchesExpectedStatus(step.expect, "success", 0)
    result.duration = Date.now() - start
    if (this.options.verbose) console.log("--- AWS credentials found, injected ---")
    return result
  }

  // -----------------------------------------------------------------------
  // GitClone block
  // -----------------------------------------------------------------------

  private runGitClone(block: ParsedComponent, step: TestStep, start: number): StepResult {
    const result: StepResult = {
      block: `gitClone:${block.id}`,
      expectedStatus: step.expect,
      actualStatus: "",
      exitCode: 0,
      passed: true,
      outputs: {},
      duration: 0,
      assertionResults: [],
    }

    const cloneURL = extractProp(block.props, "prefilledUrl")
    const ref = extractProp(block.props, "prefilledRef")
    const repoPath = extractProp(block.props, "prefilledRepoPath")
    const localPath = extractProp(block.props, "prefilledLocalPath")

    if (!cloneURL) {
      this.blockStates.set(block.id, "skipped")
      result.actualStatus = "skipped"
      result.passed = this.matchesExpectedStatus(step.expect, "skipped", 0)
      result.duration = Date.now() - start
      if (this.options.verbose) console.log("--- No prefilledUrl specified ---")
      return result
    }

    // Resolve destination path
    let destPath: string
    if (localPath) {
      destPath = path.isAbsolute(localPath) ? localPath : path.join(this.workingDir, localPath)
    } else {
      // Extract repo name from URL
      const repoName = cloneURL.split("/").pop()?.replace(".git", "") ?? "repo"
      destPath = path.join(this.workingDir, repoName)
    }

    // Inject token for GitHub URLs
    let effectiveURL = cloneURL
    if (cloneURL.includes("github.com")) {
      const gitHubAuthId = extractProp(block.props, "gitHubAuthId")
      let token = ""
      if (gitHubAuthId) {
        const creds = this.authBlockCredentials.get(gitHubAuthId)
        if (creds) token = creds["GITHUB_TOKEN"] ?? ""
      }
      if (!token) {
        // Check session env
        for (const entry of this.sessionEnv) {
          if (entry.startsWith("GITHUB_TOKEN=")) token = entry.slice(13)
          else if (entry.startsWith("GH_TOKEN=")) token = entry.slice(9)
        }
      }
      if (token) {
        effectiveURL = cloneURL.replace("https://github.com/", `https://x-access-token:${token}@github.com/`)
      }
    }

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
      result.error = String(e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@")
      result.duration = Date.now() - start
      return result
    }

    // Count files
    const fileCount = this.countFilesRecursive(destPath)

    result.outputs = { CLONE_PATH: destPath, FILE_COUNT: String(fileCount) }
    if (ref) result.outputs["REF"] = ref

    const outputMap = new Map<string, string>()
    for (const [k, v] of Object.entries(result.outputs)) outputMap.set(k, v)
    this.blockOutputs.set(block.id, outputMap)

    this.activeWorkTreePath = destPath
    this.blockStates.set(block.id, "success")
    result.actualStatus = "success"
    result.passed = this.matchesExpectedStatus(step.expect, "success", 0)
    result.duration = Date.now() - start

    if (this.options.verbose) {
      console.log(`--- Clone complete: ${fileCount} files ---`)
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

  private matchesExpectedStatus(expected: ExpectedStatus, actual: string, _exitCode: number): boolean {
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
    const missing: string[] = []
    for (const p of expected) {
      const parts = p.split(".")
      if (parts.length >= 3 && parts[0] === "outputs") {
        const blockId = parts[1]
        const outputName = parts[2]
        const outputs = this.blockOutputs.get(blockId)
        if (!outputs || !outputs.get(outputName)) {
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

  private captureFiles(fromDir: string, toDir: string): void {
    if (!fs.existsSync(fromDir)) return
    const entries = fs.readdirSync(fromDir, { withFileTypes: true })
    for (const entry of entries) {
      const src = path.join(fromDir, entry.name)
      const dest = path.join(toDir, entry.name)
      if (entry.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true })
        this.captureFiles(src, dest)
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      }
    }
  }

  private countFilesRecursive(dir: string): number {
    if (!fs.existsSync(dir)) return 0
    let count = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += this.countFilesRecursive(path.join(dir, entry.name))
      } else {
        count++
      }
    }
    return count
  }

  private runCleanup(action: { command?: string; path?: string }): void {
    let script: string
    if (action.command) {
      script = action.command
    } else if (action.path) {
      const scriptPath = path.join(path.dirname(this.runbookPath), action.path)
      script = fs.readFileSync(scriptPath, "utf-8")
    } else {
      return
    }

    try {
      execFileSync("/bin/bash", ["-c", script], {
        cwd: this.resolveOutputPath(),
        timeout: 30000,
        stdio: "pipe",
      })
    } catch {
      // Cleanup failures are non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function lowercaseFirst(s: string): string {
  if (!s) return s
  return s[0].toLowerCase() + s.slice(1)
}
