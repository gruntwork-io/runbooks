/**
 * Test configuration types and YAML parser.
 */
import * as fs from "node:fs"
import YAML from "yaml"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestConfig {
  version: number
  settings: TestSettings
  tests: TestCase[]
}

export interface TestSettings {
  working_dir?: string
  output_path?: string
  use_temp_working_dir?: boolean
  timeout?: string
  parallelizable?: boolean
}

export interface TestCase {
  name: string
  description?: string
  env?: Record<string, string>
  inputs?: Record<string, InputValue>
  steps?: TestStep[]
  assertions?: TestAssertion[]
  cleanup?: CleanupAction[]
}

export interface TestStep {
  block: string
  expect: ExpectedStatus
  env_prefix?: string
  outputs?: string[]
  missing_outputs?: string[]
  error_contains?: string
  assertions?: TestAssertion[]
}

export type ExpectedStatus =
  | "success"
  | "fail"
  | "warn"
  | "blocked"
  | "skip"
  | "config_error"

export interface TestAssertion {
  type: AssertionType
  path?: string
  contains?: string
  pattern?: string
  block?: string
  output?: string
  value?: string
  min_count?: number
  command?: string
}

export type AssertionType =
  | "file_exists"
  | "file_not_exists"
  | "file_contains"
  | "file_not_contains"
  | "file_matches"
  | "file_equals"
  | "output_equals"
  | "output_matches"
  | "output_exists"
  | "files_generated"
  | "script"
  | "dir_exists"
  | "dir_not_exists"

export interface CleanupAction {
  command?: string
  path?: string
}

export type InputValue = { literal: unknown } | { fuzz: FuzzConfig }

export interface FuzzConfig {
  type: FuzzType
  length?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  prefix?: string
  suffix?: string
  includeSpaces?: boolean
  includeSpecialChars?: boolean
  min?: number
  max?: number
  options?: string[]
  domain?: string
  minDate?: string
  maxDate?: string
  format?: string
  wordCount?: number
  minWordCount?: number
  maxWordCount?: number
  count?: number
  minCount?: number
  maxCount?: number
  schema?: string[]
}

export type FuzzType =
  | "string"
  | "int"
  | "float"
  | "bool"
  | "enum"
  | "email"
  | "url"
  | "uuid"
  | "date"
  | "timestamp"
  | "words"
  | "list"
  | "map"

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface TestResult {
  testCase: string
  status: TestStatus
  duration: number
  error?: string
  stepResults: StepResult[]
  assertions: AssertionResult[]
}

export type TestStatus = "passed" | "failed" | "skipped"

export interface StepResult {
  block: string
  expectedStatus: ExpectedStatus
  actualStatus: string
  exitCode: number
  passed: boolean
  error?: string
  errorDisplayed?: boolean
  outputs: Record<string, string>
  logs?: string
  duration: number
  assertionResults: AssertionResult[]
}

export interface AssertionResult {
  type: AssertionType
  passed: boolean
  message?: string
}

export interface RunbookTestSuite {
  runbookPath: string
  duration: number
  results: TestResult[]
  passed: number
  failed: number
  skipped: number
}

// ---------------------------------------------------------------------------
// Input value helpers
// ---------------------------------------------------------------------------

export function isLiteralInput(v: InputValue): v is { literal: unknown } {
  return "literal" in v
}

export function isFuzzInput(v: InputValue): v is { fuzz: FuzzConfig } {
  return "fuzz" in v
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export function getTimeout(settings: TestSettings): number {
  if (!settings.timeout) return 5 * 60 * 1000 // 5m default
  return parseDuration(settings.timeout)
}

export function isParallelizable(settings: TestSettings): boolean {
  return settings.parallelizable ?? true
}

export function shouldUseTempWorkingDir(settings: TestSettings): boolean {
  return settings.use_temp_working_dir ?? true
}

export function getOutputPath(settings: TestSettings): string {
  return settings.output_path || "generated"
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a duration string like "5m", "30s", "1h" into milliseconds.
 */
function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(ms|s|m|h)$/)
  if (!match) throw new Error(`Invalid duration format: ${s}`)

  const value = Number.parseInt(match[1], 10)
  switch (match[2]) {
    case "ms": return value
    case "s": return value * 1000
    case "m": return value * 60 * 1000
    case "h": return value * 60 * 60 * 1000
    default: throw new Error(`Unknown duration unit: ${match[2]}`)
  }
}

/**
 * Parse a raw YAML input value into an InputValue.
 * Handles both literal values and fuzz configs: `{ fuzz: { type: "string" } }`.
 */
function parseInputValue(raw: unknown): InputValue {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    if (obj.fuzz && typeof obj.fuzz === "object") {
      return { fuzz: obj.fuzz as FuzzConfig }
    }
  }
  return { literal: raw }
}

/** Load a test config from a YAML file. */
export function loadConfig(configPath: string): TestConfig {
  const data = fs.readFileSync(configPath, "utf-8")
  return parseConfig(data)
}

/** Parse a test config from YAML string. */
export function parseConfig(data: string): TestConfig {
  const raw = YAML.parse(data) as RawTestConfig

  // Apply defaults
  const config: TestConfig = {
    version: raw.version || 1,
    settings: {
      ...raw.settings,
    },
    tests: (raw.tests ?? []).map((tc) => ({
      name: tc.name,
      description: tc.description,
      env: tc.env,
      inputs: tc.inputs
        ? Object.fromEntries(
            Object.entries(tc.inputs).map(([k, v]) => [k, parseInputValue(v)]),
          )
        : undefined,
      steps: tc.steps?.map((step) => ({
        ...step,
        expect: step.expect || "success",
      })),
      assertions: tc.assertions,
      cleanup: tc.cleanup,
    })),
  }

  // Apply settings defaults
  if (!config.settings.timeout) config.settings.timeout = "5m"

  // Validate
  validateConfig(config)

  return config
}

function validateConfig(config: TestConfig): void {
  if (config.version !== 1) {
    throw new Error(
      `Unsupported config version: ${config.version} (only version 1 is supported)`,
    )
  }

  if (config.tests.length === 0) {
    throw new Error("At least one test case is required")
  }

  // Validate timeout format
  if (config.settings.timeout) {
    try {
      parseDuration(config.settings.timeout)
    } catch {
      throw new Error(`Invalid timeout format "${config.settings.timeout}"`)
    }
  }

  for (let i = 0; i < config.tests.length; i++) {
    const tc = config.tests[i]
    if (!tc.name) {
      throw new Error(`Test case ${i + 1}: name is required`)
    }

    // Validate steps
    if (tc.steps) {
      for (let j = 0; j < tc.steps.length; j++) {
        const step = tc.steps[j]
        if (!step.block) {
          throw new Error(`Test "${tc.name}" step ${j + 1}: block is required`)
        }

        const validStatuses: ExpectedStatus[] = [
          "success", "fail", "warn", "blocked", "skip", "config_error",
        ]
        if (!validStatuses.includes(step.expect)) {
          throw new Error(
            `Test "${tc.name}" step ${j + 1}: invalid expect value "${step.expect}"`,
          )
        }
      }
    }

    // Validate assertions
    if (tc.assertions) {
      for (let j = 0; j < tc.assertions.length; j++) {
        validateAssertion(tc.name, j, tc.assertions[j])
      }
    }

    // Validate per-step assertions
    if (tc.steps) {
      for (const step of tc.steps) {
        if (step.assertions) {
          for (let j = 0; j < step.assertions.length; j++) {
            validateAssertion(tc.name, j, step.assertions[j])
          }
        }
      }
    }
  }
}

function validateAssertion(
  testName: string,
  index: number,
  assertion: TestAssertion,
): void {
  const i = index + 1

  switch (assertion.type) {
    case "file_exists":
    case "file_not_exists":
    case "dir_exists":
    case "dir_not_exists":
      if (!assertion.path)
        throw new Error(`Test "${testName}" assertion ${i}: path is required for ${assertion.type}`)
      break

    case "file_contains":
    case "file_not_contains":
      if (!assertion.path)
        throw new Error(`Test "${testName}" assertion ${i}: path is required for ${assertion.type}`)
      if (!assertion.contains)
        throw new Error(`Test "${testName}" assertion ${i}: contains is required for ${assertion.type}`)
      break

    case "file_matches":
      if (!assertion.path)
        throw new Error(`Test "${testName}" assertion ${i}: path is required for ${assertion.type}`)
      if (!assertion.pattern)
        throw new Error(`Test "${testName}" assertion ${i}: pattern is required for ${assertion.type}`)
      break

    case "file_equals":
      if (!assertion.path)
        throw new Error(`Test "${testName}" assertion ${i}: path is required for ${assertion.type}`)
      if (assertion.value === undefined)
        throw new Error(`Test "${testName}" assertion ${i}: value is required for ${assertion.type}`)
      break

    case "output_equals":
      if (!assertion.block)
        throw new Error(`Test "${testName}" assertion ${i}: block is required for ${assertion.type}`)
      if (!assertion.output)
        throw new Error(`Test "${testName}" assertion ${i}: output is required for ${assertion.type}`)
      break

    case "output_matches":
      if (!assertion.block)
        throw new Error(`Test "${testName}" assertion ${i}: block is required for ${assertion.type}`)
      if (!assertion.output)
        throw new Error(`Test "${testName}" assertion ${i}: output is required for ${assertion.type}`)
      if (!assertion.pattern)
        throw new Error(`Test "${testName}" assertion ${i}: pattern is required for ${assertion.type}`)
      break

    case "output_exists":
      if (!assertion.block)
        throw new Error(`Test "${testName}" assertion ${i}: block is required for ${assertion.type}`)
      if (!assertion.output)
        throw new Error(`Test "${testName}" assertion ${i}: output is required for ${assertion.type}`)
      break

    case "files_generated":
      if (!assertion.block)
        throw new Error(`Test "${testName}" assertion ${i}: block is required for ${assertion.type}`)
      break

    case "script":
      if (!assertion.command)
        throw new Error(`Test "${testName}" assertion ${i}: command is required for ${assertion.type}`)
      break

    case undefined:
      throw new Error(`Test "${testName}" assertion ${i}: type is required`)

    default:
      throw new Error(`Test "${testName}" assertion ${i}: unknown assertion type "${assertion.type}"`)
  }
}

// ---------------------------------------------------------------------------
// Raw YAML shape (before transformation)
// ---------------------------------------------------------------------------

interface RawTestConfig {
  version?: number
  settings?: TestSettings
  tests?: RawTestCase[]
}

interface RawTestCase {
  name: string
  description?: string
  env?: Record<string, string>
  inputs?: Record<string, unknown>
  steps?: RawTestStep[]
  assertions?: TestAssertion[]
  cleanup?: CleanupAction[]
}

interface RawTestStep {
  block: string
  expect?: ExpectedStatus
  env_prefix?: string
  outputs?: string[]
  missing_outputs?: string[]
  error_contains?: string
  assertions?: TestAssertion[]
}
