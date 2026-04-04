/**
 * Executable registry — TypeScript port of api/executable_registry.go +
 * api/executable_handler.go.
 *
 * Scans a runbook MDX file for executable components (Command, Check, etc.)
 * and maintains an in-memory registry of all executables. Only registered
 * executables can be run via the API, preventing arbitrary command
 * invocation.
 */

import { Effect } from "effect"
import crypto from "node:crypto"
import * as path from "node:path"

import { FileSystem } from "../../services/FileSystem.js"
import {
  ExecutableNotFoundError,
  FileNotFoundError,
  RegistryError,
} from "../../errors/index.js"
import {
  findFencedCodeBlockRanges,
  isInsideFencedCodeBlock,
} from "../../mdx.js"
import type { Executable, ExecutableType } from "../../types.js"

// ---------------------------------------------------------------------------
// Component types that are scanned
// ---------------------------------------------------------------------------

/** Component types that carry scripts. */
const SCRIPT_COMPONENT_TYPES = ["Command", "Check"] as const

/**
 * All component types scanned for registry/validation purposes.
 * Includes non-script components used by HasComponent checks.
 */
const ALL_COMPONENT_TYPES = [
  "Command",
  "Check",
  "Template",
  "AwsAuth",
  "GitHubAuth",
  "GitClone",
  "GitHubPullRequest",
] as const

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

/**
 * Build a regex that matches both self-closing and container MDX components:
 *   <Type ... /> or <Type ...>...</Type>
 *
 * The props pattern handles characters inside quoted attribute values including
 * double-quoted, single-quoted, and JSX expression values with template
 * literals.
 */
export function getComponentRegex(componentType: string): RegExp {
  const propsPattern = `(?:"[^"]*"|'[^']*'|\\{\`[^\`]*\`\\}|\\{"[^"]*"\\}|\\{'[^']*'\\}|[^>])*?`
  const pattern = `<${componentType}\\s+(${propsPattern})(?:/>|>([\\s\\S]*?)</${componentType}>)`
  return new RegExp(pattern, "g")
}

/**
 * Extract a prop value from an MDX component props string.
 *
 * Handles formats:
 *   prop="value"  prop='value'  prop={`value`}  prop={"value"}  prop={'value'}
 */
export function extractProp(props: string, propName: string): string {
  const patterns = [
    new RegExp(`${propName}="([^"]*)"`, ""),
    new RegExp(`${propName}='([^']*)'`, ""),
    new RegExp(`${propName}=\\{\`([^\`]*)\`\\}`, ""),
    new RegExp(`${propName}=\\{"([^"]*)"\\}`, ""),
    new RegExp(`${propName}=\\{'([^']*)'\\}`, ""),
  ]

  for (const re of patterns) {
    const match = re.exec(props)
    if (match && match[1] !== undefined) {
      return match[1]
    }
  }

  return ""
}

// ---------------------------------------------------------------------------
// ID computation
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic ID from a component ID and its script content.
 * Uses the first 16 hex characters of a SHA-256 hash.
 */
export function computeExecutableId(
  componentId: string,
  content: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(componentId + content)
    .digest("hex")
  return hash.slice(0, 16)
}

/**
 * Compute a deterministic component ID when no explicit `id` prop is provided.
 * Uses SHA-256 of the component type and props, prefixed with the type.
 */
export function computeComponentId(
  componentType: string,
  props: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(componentType + props)
    .digest("hex")
  return `${componentType}_${hash.slice(0, 8)}`
}

/** Compute a SHA-256 hex digest of script content. */
function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex")
}

// ---------------------------------------------------------------------------
// Template variable extraction
// ---------------------------------------------------------------------------

const TEMPLATE_VAR_REGEX = /\{\{\s*\.(\w+)\s*\}\}/g

/** Extract `{{.VarName}}` variable names from script content. */
function extractTemplateVars(content: string): string[] {
  TEMPLATE_VAR_REGEX.lastIndex = 0
  const vars = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = TEMPLATE_VAR_REGEX.exec(content)) !== null) {
    if (match[1]) vars.add(match[1])
  }
  return Array.from(vars)
}

// ---------------------------------------------------------------------------
// String unescaping
// ---------------------------------------------------------------------------

/** Unescape common MDX/HTML entities. */
function unescapeString(s: string): string {
  return s
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
}

// ---------------------------------------------------------------------------
// Parsed component (internal)
// ---------------------------------------------------------------------------

export interface ParsedComponent {
  id: string
  type: string
  props: string
  content: string
  hasExplicitId: boolean
}

/**
 * Parse all components of a given type from MDX content, skipping those inside
 * fenced code blocks (documentation examples).
 */
export function parseComponents(
  content: string,
  componentType: string,
): ParsedComponent[] {
  const re = getComponentRegex(componentType)
  const codeBlockRanges = findFencedCodeBlockRanges(content)

  const components: ParsedComponent[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    // Skip components inside fenced code blocks
    if (isInsideFencedCodeBlock(match.index, codeBlockRanges)) {
      continue
    }

    const props = match[1] ?? ""
    const componentContent = match[2] ?? ""

    const explicitId = extractProp(props, "id")
    const id = explicitId || computeComponentId(componentType, props)

    if (seen.has(id)) continue
    seen.add(id)

    components.push({
      id,
      type: componentType,
      props,
      content: componentContent,
      hasExplicitId: explicitId !== "",
    })
  }

  return components
}

// ---------------------------------------------------------------------------
// ExecutableRegistry
// ---------------------------------------------------------------------------

export class ExecutableRegistry {
  private entries = new Map<string, Executable>()
  private warnings: string[] = []
  private runbookContent = ""

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  /**
   * Parse the runbook at `runbookPath`, extract all components with scripts,
   * and return a populated registry.
   *
   * Requires the FileSystem service to read the runbook and any script files
   * referenced via `path` props.
   */
  static create(runbookPath: string) {
    return Effect.gen(function* () {
      const registry = new ExecutableRegistry()
      yield* registry.parseAndRegister(runbookPath)
      return registry
    })
  }

  // -----------------------------------------------------------------------
  // Parse & register
  // -----------------------------------------------------------------------

  /**
   * Parse the runbook MDX content and register all Command/Check entries.
   */
  parseAndRegister(runbookPath: string, contentOverride?: string) {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem

      const content =
        contentOverride ?? (yield* fs.readFile(runbookPath))
      this.runbookContent = content
      const runbookDir = path.dirname(runbookPath)

      for (const componentType of SCRIPT_COMPONENT_TYPES) {
        const components = parseComponents(content, componentType)

        for (const comp of components) {
          const commandProp = extractProp(comp.props, "command")
          const pathProp = extractProp(comp.props, "path")

          if (commandProp) {
            this.registerInlineEntry(
              comp.id,
              componentType,
              commandProp,
            )
          } else if (pathProp) {
            yield* this.registerFileEntry(
              fs,
              comp.id,
              componentType,
              pathProp,
              runbookDir,
            )
          }
        }
      }
    })
  }

  // -----------------------------------------------------------------------
  // Inline registration
  // -----------------------------------------------------------------------

  private registerInlineEntry(
    componentId: string,
    componentType: string,
    scriptContent: string,
  ): void {
    scriptContent = unescapeString(scriptContent)

    const entryId = computeExecutableId(componentId, scriptContent)

    if (this.entries.has(entryId)) {
      this.warnings.push(getDuplicateWarning(componentType, componentId))
      return
    }

    this.entries.set(entryId, {
      id: entryId,
      type: "inline" as ExecutableType,
      componentId,
      componentType: componentType.toLowerCase(),
      content: scriptContent,
      contentHash: computeContentHash(scriptContent),
      language: "",
      templateVars: extractTemplateVars(scriptContent),
    })
  }

  // -----------------------------------------------------------------------
  // File-based registration
  // -----------------------------------------------------------------------

  private registerFileEntry(
    fs: { readFile: (p: string) => Effect.Effect<string, any> },
    componentId: string,
    componentType: string,
    scriptPath: string,
    runbookDir: string,
  ) {
    return Effect.gen(this, function* () {
      const fullPath = path.join(runbookDir, scriptPath)

      // Try to read the script file; on failure add a warning and skip
      const scriptContent = yield* Effect.catchAll(
        fs.readFile(fullPath),
        () => {
          this.warnings.push(
            `<${componentType} id="${componentId}">: Script file not found: ${scriptPath}`,
          )
          return Effect.succeed(null)
        },
      )

      if (scriptContent === null) return

      const entryId = computeExecutableId(componentId, scriptContent)

      if (this.entries.has(entryId)) {
        this.warnings.push(getDuplicateWarning(componentType, componentId))
        return
      }

      this.entries.set(entryId, {
        id: entryId,
        type: "file" as ExecutableType,
        componentId,
        componentType: componentType.toLowerCase(),
        content: scriptContent,
        contentHash: computeContentHash(scriptContent),
        language: "",
        path: scriptPath,
        templateVars: extractTemplateVars(scriptContent),
      })
    })
  }

  // -----------------------------------------------------------------------
  // Lookup
  // -----------------------------------------------------------------------

  /** Retrieve an entry by its ID. Returns Effect with typed error. */
  getExecutable(id: string) {
    return Effect.gen(this, function* () {
      const entry = this.entries.get(id)
      if (!entry) {
        return yield* new ExecutableNotFoundError({ id })
      }
      return entry
    })
  }

  /**
   * Return all entries without script content (safe for sending to the
   * frontend).
   */
  getAllExecutables(): Record<string, Omit<Executable, "content">> {
    const result: Record<string, Omit<Executable, "content">> = {}
    for (const [id, entry] of this.entries) {
      const { content: _content, ...safe } = entry
      result[id] = safe
    }
    return result
  }

  /**
   * Retrieve an entry by its ID synchronously.
   * Returns undefined if not found (for use in CLI test runner).
   */
  getExecutableSync(id: string): Executable | undefined {
    return this.entries.get(id)
  }

  /** Return all warnings collected during parsing. */
  getWarnings(): string[] {
    return [...this.warnings]
  }

  /**
   * Check whether the runbook contains any component of the given type
   * (including non-script types like Template, AwsAuth, etc.).
   *
   * Components inside fenced code blocks are ignored.
   */
  hasComponent(componentType: string): boolean {
    const components = parseComponents(this.runbookContent, componentType)
    return components.length > 0
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDuplicateWarning(
  componentType: string,
  componentId: string,
): string {
  return (
    `Duplicate <${componentType}> component with id '${componentId}' detected` +
    ` - Any scripts or commands associated with the second instance will be ignored.` +
    ` Add a unique id to each component to distinguish them.`
  )
}
