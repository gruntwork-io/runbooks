/**
 * Test assertion runners.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import type { TestAssertion, AssertionResult } from "./config.ts"

// ---------------------------------------------------------------------------
// Assertion executor
// ---------------------------------------------------------------------------

export interface AssertionContext {
  /** Absolute path to the output directory (workingDir + outputPath). */
  outputDir: string
  /** Block outputs collected during test execution. */
  blockOutputs: Map<string, Map<string, string>>
  /** Session env vars (as KEY=VALUE strings). */
  sessionEnv: string[]
  /** Timeout in ms for script assertions. */
  timeout: number
}

/** Run a single assertion and return the result. */
export function runAssertion(
  assertion: TestAssertion,
  ctx: AssertionContext,
): AssertionResult {
  switch (assertion.type) {
    case "file_exists": return assertFileExists(assertion.path!, ctx)
    case "file_not_exists": return assertNotExists("file", assertion.path!, ctx)
    case "dir_exists": return assertDirExists(assertion.path!, ctx)
    case "dir_not_exists": return assertNotExists("dir", assertion.path!, ctx)
    case "file_contains": return assertFileContains(assertion.path!, assertion.contains!, ctx)
    case "file_not_contains": return assertFileNotContains(assertion.path!, assertion.contains!, ctx)
    case "file_matches": return assertFileMatches(assertion.path!, assertion.pattern!, ctx)
    case "file_equals": return assertFileEquals(assertion.path!, assertion.value!, ctx)
    case "output_equals": return assertOutputEquals(assertion.block!, assertion.output!, assertion.value ?? "", ctx)
    case "output_matches": return assertOutputMatches(assertion.block!, assertion.output!, assertion.pattern!, ctx)
    case "output_exists": return assertOutputExists(assertion.block!, assertion.output!, ctx)
    case "files_generated": return assertFilesGenerated(assertion.min_count ?? 0, ctx)
    case "script": return assertScript(assertion.command!, ctx)
    default:
      return { type: assertion.type, passed: false, message: `Unknown assertion type: ${assertion.type}` }
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolvePath(relPath: string, ctx: AssertionContext): string {
  if (path.isAbsolute(relPath)) return relPath
  return path.join(ctx.outputDir, relPath)
}

// ---------------------------------------------------------------------------
// File assertions
// ---------------------------------------------------------------------------

function assertFileExists(filePath: string, ctx: AssertionContext): AssertionResult {
  const fullPath = resolvePath(filePath, ctx)
  try {
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      return { type: "file_exists", passed: false, message: `Path exists but is a directory: ${filePath}` }
    }
    return { type: "file_exists", passed: true }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { type: "file_exists", passed: false, message: `File does not exist: ${filePath}` }
    }
    return { type: "file_exists", passed: false, message: `Error checking file: ${e}` }
  }
}

function assertNotExists(
  kind: "file" | "dir",
  targetPath: string,
  ctx: AssertionContext,
): AssertionResult {
  const type = kind === "file" ? "file_not_exists" : "dir_not_exists"
  const noun = kind === "file" ? "File" : "Directory"
  const lowerNoun = kind === "file" ? "file" : "directory"
  const fullPath = resolvePath(targetPath, ctx)
  try {
    fs.statSync(fullPath)
    return { type, passed: false, message: `${noun} exists but should not: ${targetPath}` }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { type, passed: true }
    }
    return { type, passed: false, message: `Error checking ${lowerNoun}: ${e}` }
  }
}

function assertDirExists(dirPath: string, ctx: AssertionContext): AssertionResult {
  const fullPath = resolvePath(dirPath, ctx)
  try {
    const stat = fs.statSync(fullPath)
    if (!stat.isDirectory()) {
      return { type: "dir_exists", passed: false, message: `Path exists but is not a directory: ${dirPath}` }
    }
    return { type: "dir_exists", passed: true }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { type: "dir_exists", passed: false, message: `Directory does not exist: ${dirPath}` }
    }
    return { type: "dir_exists", passed: false, message: `Error checking directory: ${e}` }
  }
}

function assertFileContains(filePath: string, substring: string, ctx: AssertionContext): AssertionResult {
  const fullPath = resolvePath(filePath, ctx)
  try {
    const content = fs.readFileSync(fullPath, "utf-8")
    if (content.includes(substring)) {
      return { type: "file_contains", passed: true }
    }
    return { type: "file_contains", passed: false, message: `File ${filePath} does not contain "${substring}"` }
  } catch (e: unknown) {
    return { type: "file_contains", passed: false, message: `Failed to read file: ${e}` }
  }
}

function assertFileNotContains(filePath: string, substring: string, ctx: AssertionContext): AssertionResult {
  const fullPath = resolvePath(filePath, ctx)
  try {
    const content = fs.readFileSync(fullPath, "utf-8")
    if (!content.includes(substring)) {
      return { type: "file_not_contains", passed: true }
    }
    return { type: "file_not_contains", passed: false, message: `File ${filePath} contains "${substring}" but should not` }
  } catch (e: unknown) {
    return { type: "file_not_contains", passed: false, message: `Failed to read file: ${e}` }
  }
}

function assertFileMatches(filePath: string, pattern: string, ctx: AssertionContext): AssertionResult {
  const fullPath = resolvePath(filePath, ctx)
  try {
    const content = fs.readFileSync(fullPath, "utf-8")
    const re = new RegExp(pattern)
    if (re.test(content)) {
      return { type: "file_matches", passed: true }
    }
    return { type: "file_matches", passed: false, message: `File ${filePath} does not match pattern "${pattern}"` }
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      return { type: "file_matches", passed: false, message: `Invalid regex pattern: ${e.message}` }
    }
    return { type: "file_matches", passed: false, message: `Failed to read file: ${e}` }
  }
}

function assertFileEquals(filePath: string, expected: string, ctx: AssertionContext): AssertionResult {
  const fullPath = resolvePath(filePath, ctx)
  try {
    const content = fs.readFileSync(fullPath, "utf-8")
    if (content === expected) {
      return { type: "file_equals", passed: true }
    }
    return { type: "file_equals", passed: false, message: `File ${filePath} content does not equal expected value` }
  } catch (e: unknown) {
    return { type: "file_equals", passed: false, message: `Failed to read file: ${e}` }
  }
}

// ---------------------------------------------------------------------------
// Output assertions
// ---------------------------------------------------------------------------

function assertOutputEquals(
  blockId: string,
  outputName: string,
  expected: string,
  ctx: AssertionContext,
): AssertionResult {
  const outputs = ctx.blockOutputs.get(blockId)
  if (!outputs) {
    return { type: "output_equals", passed: false, message: `Block "${blockId}" has no outputs` }
  }
  const actual = outputs.get(outputName)
  if (actual === undefined) {
    return { type: "output_equals", passed: false, message: `Block "${blockId}" has no output "${outputName}"` }
  }
  if (actual === expected) {
    return { type: "output_equals", passed: true }
  }
  return { type: "output_equals", passed: false, message: `output ${blockId}.${outputName} = "${actual}", expected "${expected}"` }
}

function assertOutputMatches(
  blockId: string,
  outputName: string,
  pattern: string,
  ctx: AssertionContext,
): AssertionResult {
  const outputs = ctx.blockOutputs.get(blockId)
  if (!outputs) {
    return { type: "output_matches", passed: false, message: `Block "${blockId}" has no outputs` }
  }
  const actual = outputs.get(outputName)
  if (actual === undefined) {
    return { type: "output_matches", passed: false, message: `Block "${blockId}" has no output "${outputName}"` }
  }
  try {
    const re = new RegExp(pattern)
    if (re.test(actual)) {
      return { type: "output_matches", passed: true }
    }
    return { type: "output_matches", passed: false, message: `output ${blockId}.${outputName} = "${actual}" does not match pattern "${pattern}"` }
  } catch {
    return { type: "output_matches", passed: false, message: `Invalid regex pattern: ${pattern}` }
  }
}

function assertOutputExists(
  blockId: string,
  outputName: string,
  ctx: AssertionContext,
): AssertionResult {
  const outputs = ctx.blockOutputs.get(blockId)
  if (!outputs) {
    return { type: "output_exists", passed: false, message: `Block "${blockId}" has no outputs` }
  }
  if (outputs.has(outputName)) {
    return { type: "output_exists", passed: true }
  }
  return { type: "output_exists", passed: false, message: `Block "${blockId}" has no output "${outputName}"` }
}

// ---------------------------------------------------------------------------
// Files generated assertion
// ---------------------------------------------------------------------------

function assertFilesGenerated(minCount: number, ctx: AssertionContext): AssertionResult {
  let count = 0
  try {
    count = countFiles(ctx.outputDir)
  } catch (e: unknown) {
    return { type: "files_generated", passed: false, message: `Failed to walk output directory "${ctx.outputDir}": ${e}` }
  }

  if (count >= minCount) {
    return { type: "files_generated", passed: true }
  }
  return { type: "files_generated", passed: false, message: `Expected at least ${minCount} files generated, got ${count}` }
}

export function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let count = 0
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name))
    } else {
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Script assertion
// ---------------------------------------------------------------------------

/**
 * Run a script command as a bash assertion.
 * Uses execFileSync with bash to avoid shell injection risks — the command
 * string is passed as a single argument to bash -c, not interpolated into
 * a shell invocation.
 */
function assertScript(command: string, ctx: AssertionContext): AssertionResult {
  try {
    execFileSync("/bin/bash", ["-c", command], {
      cwd: ctx.outputDir,
      env: envListToRecord(ctx.sessionEnv),
      timeout: Math.min(ctx.timeout, 30000),
      stdio: "pipe",
    })
    return { type: "script", passed: true }
  } catch (e: unknown) {
    return { type: "script", passed: false, message: `Script assertion failed: ${e}` }
  }
}

export function envListToRecord(envList: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of envList) {
    const idx = entry.indexOf("=")
    if (idx >= 0) {
      result[entry.slice(0, idx)] = entry.slice(idx + 1)
    }
  }
  return result
}
