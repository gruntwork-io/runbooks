/**
 * Executable registry.
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
import { computeContentHash } from "../workspace/file.js"
import { ExecutableNotFoundError, ScriptReloadConflictError } from "../../errors/index.js"
import { findFencedCodeBlockRanges, isInsideFencedCodeBlock } from "../../mdx.js"
import type { Executable, ExecutableType, ScriptFileChange } from "../../types.js"

// ---------------------------------------------------------------------------
// Component types that are scanned
// ---------------------------------------------------------------------------

/** Component types that carry scripts. */
const SCRIPT_COMPONENT_TYPES = ["Command", "Check"] as const

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
 * Matches one `name=value` prop. Each match consumes the whole value, so text
 * inside a value (e.g. `--external-id="..."` in a command) is never read as a
 * prop name. Values in other forms (`timeout={300}`, bare `usePty`) are skipped.
 */
const PROP_REGEX =
  /(?:^|\s)([A-Za-z_$][\w$-]*)=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\}|\{(true|false)\})/g

/**
 * Extract a prop value from an MDX component props string.
 *
 * Handles formats:
 *   prop="value"  prop='value'  prop={`value`}  prop={"value"}  prop={'value'}
 *   prop={true}  prop={false}
 */
export function extractProp(props: string, propName: string): string {
  for (const match of props.matchAll(PROP_REGEX)) {
    if (match[1] !== propName) continue
    for (let i = 2; i < match.length; i++) {
      if (match[i] !== undefined) return match[i]!
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
export function computeExecutableId(componentId: string, content: string): string {
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
export function computeComponentId(componentType: string, props: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(componentType + props)
    .digest("hex")
  return `${componentType}_${hash.slice(0, 8)}`
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
  /** Offset of the component's opening tag in the MDX source. */
  index: number
}

/**
 * Parse all components of a given type from MDX content, skipping those inside
 * fenced code blocks (documentation examples).
 */
export function parseComponents(content: string, componentType: string): ParsedComponent[] {
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
      index: match.index,
    })
  }

  return components
}

// ---------------------------------------------------------------------------
// ExecutableRegistry
// ---------------------------------------------------------------------------

export class ExecutableRegistry {
  private entries = new Map<string, Executable>()
  /** Absolute path each file entry's script was read from, keyed by entry ID. */
  private scriptPaths = new Map<string, string>()
  private warnings: string[] = []

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

      const content = contentOverride ?? (yield* fs.readFile(runbookPath))
      const runbookDir = path.dirname(runbookPath)

      for (const componentType of SCRIPT_COMPONENT_TYPES) {
        const components = parseComponents(content, componentType)

        for (const comp of components) {
          const commandProp = extractProp(comp.props, "command")
          const pathProp = extractProp(comp.props, "path")

          if (commandProp) {
            this.registerInlineEntry(comp.id, componentType, commandProp)
          } else if (pathProp) {
            yield* this.registerFileEntry(fs, comp.id, componentType, pathProp, runbookDir)
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
      const scriptContent = yield* Effect.catchAll(fs.readFile(fullPath), () => {
        this.warnings.push(
          `<${componentType} id="${componentId}">: Script file not found: ${scriptPath}`,
        )
        return Effect.succeed(null)
      })

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
      this.scriptPaths.set(entryId, fullPath)
    })
  }

  // -----------------------------------------------------------------------
  // Script files changed after registration
  // -----------------------------------------------------------------------

  /** Absolute paths of the script files the file entries were read from. */
  getScriptPaths(): string[] {
    return [...new Set(this.scriptPaths.values())]
  }

  /** IDs of the components whose file entry was read from one of `scriptPaths`. */
  getComponentIdsForScripts(scriptPaths: readonly string[]): string[] {
    const componentIds: string[] = []
    for (const [entryId, scriptPath] of this.scriptPaths) {
      const entry = this.entries.get(entryId)
      if (entry && scriptPaths.includes(scriptPath)) componentIds.push(entry.componentId)
    }
    return componentIds
  }

  /**
   * The script file of `componentId`'s entry as it is on disk now, when that
   * differs from the registered copy. Null when the two match, when the file
   * can't be read, and when the component has no file entry.
   */
  getScriptFileChange(componentId: string) {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem
      const found = this.findFileEntry(componentId)
      if (!found) return null

      const diskContent = yield* Effect.catchAll(fs.readFile(found.scriptPath), () =>
        Effect.succeed(null),
      )
      if (diskContent === null) return null

      const diskContentHash = computeContentHash(diskContent)
      if (diskContentHash === found.entry.contentHash) return null

      const change: ScriptFileChange = {
        registeredContent: found.entry.content,
        diskContent,
        diskContentHash,
      }
      return change
    })
  }

  /**
   * Replace `componentId`'s file entry with its script as it is on disk, so
   * Run executes that version. `reviewedHash` is the content hash of the
   * version the user reviewed.
   *
   * Fails with ScriptReloadConflictError, leaving the entry as it was, when
   * the file's content does not have that hash. Fails with
   * ExecutableNotFoundError when the component has no file entry.
   */
  reloadFileEntry(componentId: string, reviewedHash: string) {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem
      const found = this.findFileEntry(componentId)
      if (!found) {
        return yield* new ExecutableNotFoundError({ id: componentId })
      }
      const { entry, scriptPath } = found

      const content = yield* fs.readFile(scriptPath)
      if (computeContentHash(content) !== reviewedHash) {
        return yield* new ScriptReloadConflictError({
          path: scriptPath,
          message: `${entry.path} changed again after you reviewed it. Review the latest change, then reload the script.`,
        })
      }

      // The entry ID is derived from the content, so the entry moves to a new ID.
      const entryId = computeExecutableId(componentId, content)
      this.entries.delete(entry.id)
      this.scriptPaths.delete(entry.id)
      this.entries.set(entryId, {
        ...entry,
        id: entryId,
        content,
        contentHash: reviewedHash,
        templateVars: extractTemplateVars(content),
      })
      this.scriptPaths.set(entryId, scriptPath)
    })
  }

  private findFileEntry(
    componentId: string,
  ): { entry: Executable; scriptPath: string } | undefined {
    for (const [entryId, scriptPath] of this.scriptPaths) {
      const entry = this.entries.get(entryId)
      if (entry?.componentId === componentId) return { entry, scriptPath }
    }
    return undefined
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDuplicateWarning(componentType: string, componentId: string): string {
  return (
    `Duplicate <${componentType}> component with id '${componentId}' detected` +
    ` - Any scripts or commands associated with the second instance will be ignored.` +
    ` Add a unique id to each component to distinguish them.`
  )
}
