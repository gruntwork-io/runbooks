/**
 * The tools a <Prerequisites> block checks, read from the YAML in its code
 * fence. The main process, the renderer and the test CLI all parse it here,
 * so the block shows exactly the tools that get checked. The renderer bundles
 * this module, so it must not import Node.js modules.
 *
 *   tools:
 *     - git
 *     - name: tofu
 *       version: ">= 1.6"
 *       install: "[Install OpenTofu](https://opentofu.org/docs/intro/install/)"
 *     - name: gh
 *       optional: true
 */
import YAML from "yaml"
import { errorMessage } from "../../errors/message.ts"
import { parseConstraint, type VersionConstraint } from "./version.ts"

export interface PrerequisiteTool {
  /** The command looked up on PATH, such as "tofu". */
  readonly name: string
  /** Markdown that says what the runbook uses the tool for. */
  readonly description?: string | undefined
  /** The version constraint as written, such as ">= 1.6". */
  readonly version?: string | undefined
  readonly constraint?: VersionConstraint | undefined
  /**
   * The arguments that make the tool print its version. Set only when the
   * version is read: the tool has a constraint (they default to --version),
   * or the runbook gives them.
   */
  readonly versionArgs?: readonly string[] | undefined
  /** Markdown that says how to install the tool, shown when it's missing or the wrong version. */
  readonly install?: string | undefined
  /** Whether the runbook can do without the tool: missing, it's a warning, not a failure. */
  readonly optional: boolean
  /** The start of the tool's output names: `<outputKey>_path` and `<outputKey>_version`. */
  readonly outputKey: string
}

export interface PrerequisitesSpec {
  readonly tools: readonly PrerequisiteTool[]
}

/** A parsed tool list, or what the runbook's author has to fix. */
export type ParsedSpec = { ok: true; spec: PrerequisitesSpec } | { ok: false; error: string }

/** The arguments a tool's version is read with when the runbook doesn't give any. */
export const DEFAULT_VERSION_ARGS: readonly string[] = ["--version"]

/** A command name: never a path, whitespace or shell syntax. */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

const TOOL_KEYS = ["name", "description", "version", "versionArgs", "install", "optional"]

/**
 * A code fence: three or more backticks or tildes, an optional info string,
 * and the lines up to a closing fence of at least as many of the same.
 */
const CODE_FENCE = /(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1/m

/**
 * The tool list in a <Prerequisites> block's MDX source: the text of the code
 * fence between its tags, or null when it has none.
 */
export function extractToolList(blockContent: string): string | null {
  return CODE_FENCE.exec(blockContent)?.[2] ?? null
}

/**
 * Whether a <Prerequisites> block's MDX source has anything besides its tool
 * list's code fence. The block refuses that, since MDX turns the text around
 * a fence into elements (extractYamlFromChildren), so the test CLI does too.
 */
export function hasTextOutsideToolList(blockContent: string): boolean {
  return blockContent.replace(CODE_FENCE, "").trim() !== ""
}

/** How to give a <Prerequisites> block its tool list, for the error about one without it. */
export const TOOL_LIST_FENCE_HINT =
  "Put a YAML code fence (```yaml ... ```) with a `tools:` list inside the block, and nothing else."

/**
 * The start of the output names a tool's results get, from its name. A
 * character that can't be in an output name becomes "_", and a leading digit
 * gets a "_" before it: `session-manager-plugin` publishes
 * `session_manager_plugin_path`.
 */
export function toolOutputKey(name: string): string {
  const key = name.replace(/[^A-Za-z0-9_]/g, "_")
  return /^\d/.test(key) ? `_${key}` : key
}

/**
 * Parse the YAML in a <Prerequisites> block's code fence. The error is the
 * YAML's own, or says what's wrong with which tool.
 */
export function parsePrerequisitesSpec(yamlText: string): ParsedSpec {
  let doc: unknown
  try {
    doc = YAML.parse(yamlText)
  } catch (err) {
    return { ok: false, error: `The tool list isn't valid YAML: ${errorMessage(err)}` }
  }

  if (!isRecord(doc) || !("tools" in doc)) {
    return { ok: false, error: "List the tools under a `tools:` key." }
  }
  const unknownKey = Object.keys(doc).find((key) => key !== "tools")
  if (unknownKey !== undefined) {
    return { ok: false, error: `Unknown key "${unknownKey}": the YAML has only a \`tools:\` list.` }
  }
  if (!Array.isArray(doc.tools) || doc.tools.length === 0) {
    return { ok: false, error: "`tools:` must be a list with at least one tool." }
  }

  const tools: PrerequisiteTool[] = []
  // The name of the tool that has each output key, to refuse a second one
  const nameByOutputKey = new Map<string, string>()
  for (const [i, entry] of (doc.tools as unknown[]).entries()) {
    const parsed = parseTool(entry, i)
    if (!parsed.ok) return parsed
    const { tool } = parsed

    const other = nameByOutputKey.get(tool.outputKey)
    if (other === tool.name) {
      return { ok: false, error: `"${tool.name}" is listed twice.` }
    }
    if (other !== undefined) {
      return {
        ok: false,
        error: `"${other}" and "${tool.name}" would publish the same outputs (${tool.outputKey}_path). List only one of them.`,
      }
    }
    nameByOutputKey.set(tool.outputKey, tool.name)
    tools.push(tool)
  }
  return { ok: true, spec: { tools } }
}

function parseTool(
  entry: unknown,
  index: number,
): { ok: true; tool: PrerequisiteTool } | { ok: false; error: string } {
  const fields = typeof entry === "string" ? { name: entry } : entry
  if (!isRecord(fields)) {
    return { ok: false, error: `Tool ${index + 1} must be a name, or a map with a \`name\`.` }
  }

  const { name } = fields
  if (typeof name !== "string" || name === "") {
    return {
      ok: false,
      error: `Tool ${index + 1} needs a \`name\`: the command to look for on PATH.`,
    }
  }
  if (!TOOL_NAME.test(name)) {
    return {
      ok: false,
      error: `"${name}" isn't a command name. Use the name you'd type to run it, such as "tofu", not a path.`,
    }
  }
  const unknownKey = Object.keys(fields).find((key) => !TOOL_KEYS.includes(key))
  if (unknownKey !== undefined) {
    return {
      ok: false,
      error: `"${name}" has an unknown key "${unknownKey}". A tool can have ${TOOL_KEYS.join(", ")}.`,
    }
  }

  const { description, version, versionArgs, install, optional } = fields
  for (const [key, value] of Object.entries({ description, install })) {
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, error: `"${name}": \`${key}\` must be text.` }
    }
  }
  if (optional !== undefined && typeof optional !== "boolean") {
    return { ok: false, error: `"${name}": \`optional\` must be true or false.` }
  }

  let constraint: VersionConstraint | undefined
  if (version !== undefined) {
    // An unquoted 1.10 arrives as the number 1.1, so a number is refused
    // rather than turned back into text.
    if (typeof version === "number") {
      return {
        ok: false,
        error: `"${name}": quote the version, as in version: ">= 1.6". YAML reads an unquoted 1.10 as the number 1.1.`,
      }
    }
    if (typeof version !== "string") {
      return { ok: false, error: `"${name}": \`version\` must be text, such as ">= 1.6".` }
    }
    const parsed = parseConstraint(version)
    if (!parsed.ok) return { ok: false, error: `"${name}": ${parsed.error}.` }
    constraint = parsed.constraint
  }

  let args: readonly string[] | undefined
  if (typeof versionArgs === "string") {
    args = versionArgs.split(/\s+/).filter((arg) => arg !== "")
  } else if (Array.isArray(versionArgs) && versionArgs.every((arg) => typeof arg === "string")) {
    args = versionArgs as string[]
  } else if (versionArgs !== undefined) {
    return {
      ok: false,
      error: `"${name}": \`versionArgs\` must be a list of arguments, such as [version, --client].`,
    }
  } else if (constraint) {
    args = DEFAULT_VERSION_ARGS
  }

  return {
    ok: true,
    tool: {
      name,
      description: description as string | undefined,
      version: version as string | undefined,
      constraint,
      versionArgs: args,
      install: install as string | undefined,
      optional: optional === true,
      outputKey: toolOutputKey(name),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
