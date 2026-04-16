/**
 * Test command: discovers runbooks, runs tests, reports results.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { Command } from "commander"
import {
  loadConfig,
  getTimeout,
  getOutputPath,
  isParallelizable,
  shouldUseTempWorkingDir,
  type RunbookTestSuite,
} from "../test/config.ts"
import { TestExecutor } from "../test/executor.ts"
import { TextReporter, JUnitReporter, reportToFile, type Reporter } from "../test/reporter.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface TestOptions {
  verbose: boolean
  test?: string
  output: string
  outputFile?: string
  maxParallel: number
}

// ---------------------------------------------------------------------------
// Register command
// ---------------------------------------------------------------------------

export function registerTestCommand(program: Command): void {
  program
    .command("test")
    .description("Run automated tests for runbooks")
    .argument("<paths...>", "Runbook paths or directories (use /... for recursive)")
    .option("-v, --verbose", "Enable verbose output", false)
    .option("--test <name>", "Run only the specified test case")
    .option("--output <format>", "Output format (text or junit)", "text")
    .option("--output-file <path>", "Write output to file")
    .option("--max-parallel <n>", "Maximum parallel test suites", "0")
    .action(async (paths: string[], opts: TestOptions) => {
      await runTestCommand(paths, opts)
    })
}

// ---------------------------------------------------------------------------
// Main test flow
// ---------------------------------------------------------------------------

async function runTestCommand(paths: string[], opts: TestOptions): Promise<void> {
  // Discover runbooks
  const runbooks = discoverRunbooks(paths)
  if (runbooks.length === 0) {
    console.error(`No runbooks found matching ${paths.join(", ")}`)
    process.exit(1)
  }

  // Run test suites
  const suites = await runTestSuites(runbooks, opts)

  // Report results
  reportResults(suites, opts)

  // Exit with failure code if any tests failed
  const totalFailed = suites.reduce((n, s) => n + s.failed, 0)
  if (totalFailed > 0) process.exit(1)
}

// ---------------------------------------------------------------------------
// Runbook discovery
// ---------------------------------------------------------------------------

function discoverRunbooks(paths: string[]): string[] {
  const runbooks: string[] = []
  const seen = new Set<string>()

  for (const pattern of paths) {
    // Handle recursive glob: path/...
    if (pattern.endsWith("/...")) {
      let basePath = pattern.slice(0, -4)
      if (!basePath || basePath === ".") basePath = "."

      walkDir(basePath, (filePath) => {
        if (path.basename(filePath) === "runbook.mdx") {
          const dir = path.dirname(filePath)
          const testConfig = path.join(dir, "runbook_test.yml")
          if (fs.existsSync(testConfig)) {
            const abs = path.resolve(filePath)
            if (!seen.has(abs)) {
              seen.add(abs)
              runbooks.push(abs)
            }
          }
        }
      })
      continue
    }

    // Handle direct path
    let runbookPath: string
    try {
      const stat = fs.statSync(pattern)
      runbookPath = stat.isDirectory()
        ? path.join(pattern, "runbook.mdx")
        : pattern
    } catch {
      console.error(`Path not found: ${pattern}`)
      process.exit(1)
    }

    if (!fs.existsSync(runbookPath)) {
      console.error(`Runbook not found: ${runbookPath}`)
      process.exit(1)
    }

    const dir = path.dirname(runbookPath)
    const testConfig = path.join(dir, "runbook_test.yml")
    if (!fs.existsSync(testConfig)) {
      console.warn(`Warning: no runbook_test.yml found for ${runbookPath}, skipping`)
      continue
    }

    const abs = path.resolve(runbookPath)
    if (!seen.has(abs)) {
      seen.add(abs)
      runbooks.push(abs)
    }
  }

  return runbooks
}

function walkDir(dir: string, callback: (path: string) => void): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walkDir(full, callback)
      } else {
        callback(full)
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

// ---------------------------------------------------------------------------
// Test suite orchestration
// ---------------------------------------------------------------------------

async function runTestSuites(
  runbooks: string[],
  opts: TestOptions,
): Promise<RunbookTestSuite[]> {
  // Group by parallelizable status
  const parallel: string[] = []
  const sequential: string[] = []

  for (const runbook of runbooks) {
    try {
      const config = loadTestConfig(runbook)
      if (isParallelizable(config.settings)) {
        parallel.push(runbook)
      } else {
        sequential.push(runbook)
      }
    } catch (e) {
      console.error(`Error loading config for ${runbook}: ${e}`)
    }
  }

  const suites: RunbookTestSuite[] = []

  // Run parallel suites
  if (parallel.length > 0) {
    let maxWorkers = opts.maxParallel || 4
    if (maxWorkers > parallel.length) maxWorkers = parallel.length

    // For simplicity, run sequentially for now.
    // True parallelism would require worker_threads or child_process forking.
    // TODO: Add parallel execution with worker pool
    for (const runbook of parallel) {
      suites.push(await runTestSuite(runbook, opts))
    }
  }

  // Run sequential suites
  for (const runbook of sequential) {
    suites.push(await runTestSuite(runbook, opts))
  }

  return suites
}

async function runTestSuite(
  runbookPath: string,
  opts: TestOptions,
): Promise<RunbookTestSuite> {
  const start = Date.now()
  const suite: RunbookTestSuite = {
    runbookPath,
    duration: 0,
    results: [],
    passed: 0,
    failed: 0,
    skipped: 0,
  }

  let config
  try {
    config = loadTestConfig(runbookPath)
  } catch (e: unknown) {
    suite.results.push({
      testCase: "config",
      status: "failed",
      error: `Failed to load config: ${e}`,
      duration: 0,
      stepResults: [],
      assertions: [],
    })
    suite.failed = 1
    suite.duration = Date.now() - start
    return suite
  }

  // Resolve working directory
  let workDir: string
  let cleanupWorkDir: (() => void) | null = null

  try {
    if (shouldUseTempWorkingDir(config.settings)) {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-workdir-"))
      cleanupWorkDir = () => { try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {} }
    } else if (config.settings.working_dir) {
      if (config.settings.working_dir === ".") {
        workDir = path.dirname(runbookPath)
      } else if (path.isAbsolute(config.settings.working_dir)) {
        workDir = config.settings.working_dir
      } else {
        workDir = path.join(path.dirname(runbookPath), config.settings.working_dir)
      }
    } else {
      workDir = process.cwd()
    }
  } catch (e: unknown) {
    suite.results.push({
      testCase: "setup",
      status: "failed",
      error: `${e}`,
      duration: 0,
      stepResults: [],
      assertions: [],
    })
    suite.failed = 1
    suite.duration = Date.now() - start
    return suite
  }

  const outputPath = getOutputPath(config.settings)
  const timeout = getTimeout(config.settings)

  // Create executor
  const runner = new TestExecutor(runbookPath, workDir, outputPath, {
    timeout,
    verbose: opts.verbose,
  })

  try {
    await runner.init()
  } catch (e: unknown) {
    suite.results.push({
      testCase: "setup",
      status: "failed",
      error: `Failed to create test runner: ${e}`,
      duration: 0,
      stepResults: [],
      assertions: [],
    })
    suite.failed = 1
    suite.duration = Date.now() - start
    cleanupWorkDir?.()
    return suite
  }

  runner.printRunbookHeader()

  // Run each test case
  for (const tc of config.tests) {
    if (opts.test && tc.name !== opts.test) continue

    runner.printTestHeader(tc.name)
    const result = runner.runTest(tc)
    suite.results.push(result)

    switch (result.status) {
      case "passed": suite.passed++; break
      case "failed": suite.failed++; break
      case "skipped": suite.skipped++; break
    }
  }

  runner.close()
  cleanupWorkDir?.()
  suite.duration = Date.now() - start
  return suite
}

function loadTestConfig(runbookPath: string) {
  const dir = path.dirname(runbookPath)
  const configPath = path.join(dir, "runbook_test.yml")
  return loadConfig(configPath)
}

// ---------------------------------------------------------------------------
// Result reporting
// ---------------------------------------------------------------------------

function reportResults(suites: RunbookTestSuite[], opts: TestOptions): void {
  let reporter: Reporter

  switch (opts.output) {
    case "junit":
      reporter = new JUnitReporter(process.stdout)
      break
    default:
      reporter = new TextReporter(process.stdout, opts.verbose)
      break
  }

  if (opts.outputFile) {
    try {
      reportToFile(reporter, suites, opts.outputFile)
    } catch (e: unknown) {
      console.error(`Error writing to output file: ${e}`)
      reporter.report(suites)
    }
    return
  }

  reporter.report(suites)
}
