/**
 * Input validation for runbook test run.
 *
 * Parses MDX component blocks, validates their configuration, and validates
 * test input values against boilerplate variable schemas.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Either } from "effect"
import { parseBoilerplateConfig } from "../../src/domain/boilerplate/config.ts"
import { validateVariableValue } from "../../src/domain/boilerplate/validators.ts"
import {
  extractProp,
  parseComponents,
  getComponentRegex,
  type ParsedComponent,
} from "../../src/domain/registry/executable.ts"
import {
  findFencedCodeBlockRanges,
  isInsideFencedCodeBlock,
} from "../../src/mdx.ts"
import type { BoilerplateConfig, BoilerplateVariable } from "../../src/types.ts"
import { AUTH_BLOCK_TYPES, BLOCK_TYPES, PR_BLOCK_TYPES } from "./blockTypes.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationError {
  inputKey: string
  message: string
}

export interface ConfigError {
  componentType: string
  componentId: string
  message: string
}

export interface InputsBlockSchema {
  id: string
  variables: Map<string, BoilerplateVariable>
}

// ---------------------------------------------------------------------------
// Known block types
// ---------------------------------------------------------------------------

const KNOWN_BLOCK_TYPES = new Set<string>(BLOCK_TYPES)

// ---------------------------------------------------------------------------
// Auth block dependency types
// ---------------------------------------------------------------------------

const AUTH_DEPENDENT_TYPES = ["Check", "Command", "Finish", "GitClone", ...PR_BLOCK_TYPES] as const

const AUTH_PROP_NAME_OVERRIDES: Record<string, string> = {
  GitHubAuth: "githubAuthId",
  // GitAuth (generic) and GitLabAuth are referenced by the provider-agnostic
  // `gitAuthId`. GitAuth's computed default is already `gitAuthId`; GitLabAuth's
  // would be `gitLabAuthId`, so it needs an explicit override.
  GitLabAuth: "gitAuthId",
}

function authBlockRefPropName(blockType: string): string {
  return AUTH_PROP_NAME_OVERRIDES[blockType] ?? lowercaseFirst(blockType) + "Id"
}

export interface AuthDependency {
  blockId: string
  authBlockId: string
  authBlockType: string
}

// ---------------------------------------------------------------------------
// InputValidator
// ---------------------------------------------------------------------------

export class InputValidator {
  private schemas = new Map<string, InputsBlockSchema>()
  private configErrors: ConfigError[] = []
  private allComponents: ParsedComponent[] = []

  constructor(
    private runbookPath: string,
  ) {}

  /** Parse and validate all components. Call before using other methods. */
  init(): void {
    const content = fs.readFileSync(this.runbookPath, "utf-8")
    const runbookDir = path.dirname(this.runbookPath)

    // Detect unknown block types
    this.detectUnknownBlocks(content)

    // Parse all component types
    const components: ParsedComponent[] = []
    components.push(...this.parseInputsBlocks(content, runbookDir))
    components.push(...this.parseRunBlocks(content, "Check"))
    components.push(...this.parseRunBlocks(content, "Command"))
    components.push(...this.parseRunBlocks(content, "Finish"))
    components.push(...this.parseTemplateBlocks(content, runbookDir))
    components.push(...this.parseTemplateInlineBlocks(content))
    for (const authType of AUTH_BLOCK_TYPES) {
      components.push(...this.parseAuthBlocks(content, authType))
    }
    components.push(...this.parseAuthBlocks(content, "GitClone"))
    for (const prType of PR_BLOCK_TYPES) {
      components.push(...this.parseAuthBlocks(content, prType))
    }

    // Sort by document position (each component's own offset in the source)
    components.sort((a, b) => a.index - b.index)

    this.allComponents = components
  }

  getComponents(): ParsedComponent[] {
    return this.allComponents
  }

  getConfigErrors(): ConfigError[] {
    return this.configErrors
  }

  hasConfigErrors(): boolean {
    return this.configErrors.length > 0
  }

  getAllSchemas(): Map<string, InputsBlockSchema> {
    return this.schemas
  }

  getConfigError(componentType: string, componentId: string): string {
    for (const err of this.configErrors) {
      if (err.componentType === componentType && err.componentId === componentId) {
        return err.message
      }
    }
    return ""
  }

  /** Validate test input values against discovered boilerplate schemas. */
  validateInputValues(inputs: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = []

    for (const [key, value] of Object.entries(inputs)) {
      const parts = key.split(".", 2)
      if (parts.length !== 2) continue

      const [inputsId, varName] = parts
      const schema = this.schemas.get(inputsId)
      if (!schema) continue

      const variable = schema.variables.get(varName)
      if (!variable) continue

      errors.push(...validateValue(key, value, variable))
    }

    return errors
  }

  // -----------------------------------------------------------------------
  // Component parsing
  // -----------------------------------------------------------------------

  private detectUnknownBlocks(content: string): void {
    const codeBlockRanges = findFencedCodeBlockRanges(content)
    const blockRe = /[<]([A-Z][a-zA-Z0-9]*)(?:\s|[/]>|>)/g
    const seen = new Set<string>()
    let match: RegExpExecArray | null

    while ((match = blockRe.exec(content)) !== null) {
      if (isInsideFencedCodeBlock(match.index, codeBlockRanges)) continue
      const blockType = match[1]
      if (seen.has(blockType) || KNOWN_BLOCK_TYPES.has(blockType)) continue
      seen.add(blockType)
      this.configErrors.push({
        componentType: blockType,
        componentId: "(unknown)",
        message: `Unknown block type "${blockType}" is not supported by runbooks test`,
      })
    }
  }

  private parseInputsBlocks(content: string, runbookDir: string): ParsedComponent[] {
    const components = parseComponents(content, "Inputs")
    const results: ParsedComponent[] = []

    for (const comp of components) {
      const errors = validateComponent(comp)
      if (errors.length > 0) {
        this.configErrors.push(...errors)
        results.push(comp)
        continue
      }

      if (this.schemas.has(comp.id)) continue

      const schema: InputsBlockSchema = { id: comp.id, variables: new Map() }

      const configPath = extractProp(comp.props, "path")
      if (configPath) {
        const boilerplatePath = resolveBoilerplatePath(runbookDir, configPath)
        try {
          const cfg = loadBoilerplateConfig(boilerplatePath)
          for (const v of cfg.variables) {
            schema.variables.set(v.name, v)
          }
        } catch (e: unknown) {
          this.configErrors.push({
            componentType: "Inputs",
            componentId: comp.id,
            message: `Failed to load boilerplate config: ${e}`,
          })
        }
      } else {
        const yamlContent = comp.content.trim() ? extractInlineYAML(comp.content) : ""
        if (yamlContent === null) {
          this.configErrors.push({
            componentType: "Inputs",
            componentId: comp.id,
            message: MISSING_FENCE_MESSAGE,
          })
        } else if (yamlContent) {
          try {
            const cfg = parseConfig(yamlContent)
            for (const v of cfg.variables) {
              schema.variables.set(v.name, v)
            }
          } catch (e: unknown) {
            this.configErrors.push({
              componentType: "Inputs",
              componentId: comp.id,
              message: `Failed to parse inline YAML: ${e}`,
            })
          }
        }
      }

      this.schemas.set(comp.id, schema)
      results.push(comp)
    }

    return results
  }

  private parseRunBlocks(content: string, componentType: string): ParsedComponent[] {
    const components = parseComponents(content, componentType)
    for (const comp of components) {
      this.configErrors.push(...validateComponent(comp))
    }
    return components
  }

  private parseTemplateBlocks(content: string, runbookDir: string): ParsedComponent[] {
    const components = parseComponents(content, "Template")
    const results: ParsedComponent[] = []

    for (const comp of components) {
      const errors = validateComponent(comp)
      if (errors.length > 0) {
        this.configErrors.push(...errors)
        results.push(comp)
        continue
      }

      const templatePath = extractProp(comp.props, "path")
      const templateDir = path.join(runbookDir, templatePath)
      if (!fs.existsSync(templateDir)) {
        this.configErrors.push({
          componentType: "Template",
          componentId: comp.id,
          message: `Template directory not found: ${templatePath}`,
        })
        results.push(comp)
        continue
      }

      const boilerplatePath = resolveBoilerplatePath(runbookDir, templatePath)
      try {
        const cfg = loadBoilerplateConfig(boilerplatePath)
        const schema: InputsBlockSchema = { id: comp.id, variables: new Map() }
        for (const v of cfg.variables) {
          schema.variables.set(v.name, v)
        }
        this.schemas.set(comp.id, schema)
      } catch (e: unknown) {
        this.configErrors.push({
          componentType: "Template",
          componentId: comp.id,
          message: `Failed to load boilerplate config: ${e}`,
        })
      }

      results.push(comp)
    }

    return results
  }

  private parseTemplateInlineBlocks(content: string): ParsedComponent[] {
    const components = parseComponents(content, "TemplateInline")
    for (const comp of components) {
      this.configErrors.push(...validateComponent(comp))
    }
    return components
  }

  private parseAuthBlocks(content: string, componentType: string): ParsedComponent[] {
    const components = parseComponents(content, componentType)
    for (const comp of components) {
      if (!comp.hasExplicitId) {
        this.configErrors.push({
          componentType,
          componentId: "(missing)",
          message: "The 'id' prop is required",
        })
      }
    }
    return components
  }
}

// ---------------------------------------------------------------------------
// Auth dependency parsing
// ---------------------------------------------------------------------------

export function parseAuthDependencies(runbookPath: string): Map<string, AuthDependency> {
  const content = fs.readFileSync(runbookPath, "utf-8")
  const deps = new Map<string, AuthDependency>()
  const codeBlockRanges = findFencedCodeBlockRanges(content)

  for (const blockType of AUTH_DEPENDENT_TYPES) {
    const re = getComponentRegex(blockType)
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      if (isInsideFencedCodeBlock(match.index, codeBlockRanges)) continue
      const props = match[1] ?? ""
      const blockId = extractProp(props, "id")
      if (!blockId) continue

      for (const authType of AUTH_BLOCK_TYPES) {
        const propName = authBlockRefPropName(authType)
        const authId = extractProp(props, propName)
        if (authId) {
          deps.set(blockId, { blockId, authBlockId: authId, authBlockType: authType })
          break
        }
      }
    }
  }

  return deps
}

// ---------------------------------------------------------------------------
// Template block parsing (for the test runner)
// ---------------------------------------------------------------------------

export interface TemplateInlineBlock {
  id: string
  content: string
  outputPath: string
  inputsId: string
  target: string
  generateFile: boolean
}

export interface TemplateBlock {
  id: string
  templatePath: string
  /** The blocks named by `inputsId`, in order (later ids override earlier ones). */
  inputsIds: string[]
  target: string
}

// Both maps come from parseComponents, like the registry and InputValidator:
// fenced examples are skipped and the first block with an id wins, so a
// documented example can't replace the real block's content.

export function parseTemplateInlineBlocks(runbookPath: string): Map<string, TemplateInlineBlock> {
  const content = fs.readFileSync(runbookPath, "utf-8")
  const blocks = new Map<string, TemplateInlineBlock>()

  for (const comp of parseComponents(content, "TemplateInline")) {
    if (!comp.hasExplicitId) continue
    blocks.set(comp.id, {
      id: comp.id,
      content: extractTemplateContent(comp.content),
      outputPath: extractProp(comp.props, "outputPath"),
      inputsId: extractProp(comp.props, "inputsId"),
      target: extractProp(comp.props, "target"),
      generateFile: extractProp(comp.props, "generateFile") === "true",
    })
  }

  return blocks
}

export function parseTemplateBlocks(runbookPath: string): Map<string, TemplateBlock> {
  const content = fs.readFileSync(runbookPath, "utf-8")
  const blocks = new Map<string, TemplateBlock>()

  for (const comp of parseComponents(content, "Template")) {
    const templatePath = extractProp(comp.props, "path")
    if (!comp.hasExplicitId || !templatePath) continue
    blocks.set(comp.id, {
      id: comp.id,
      templatePath,
      inputsIds: extractInputsIds(comp.props),
      target: extractProp(comp.props, "target"),
    })
  }

  return blocks
}

/**
 * The ids an `inputsId` prop names, in order: one for `inputsId="a"`, each
 * quoted id for `inputsId={["a", "b"]}`, none without the prop.
 */
export function extractInputsIds(props: string): string[] {
  const single = extractProp(props, "inputsId")
  if (single) return [single]
  const list = /(?:^|\s)inputsId=\{\s*\[([^\]]*)\]\s*\}/.exec(props)
  if (!list) return []
  return [...list[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .filter((id) => id !== "")
}

// ---------------------------------------------------------------------------
// Component validation
// ---------------------------------------------------------------------------

function validateComponent(comp: ParsedComponent): ConfigError[] {
  const errors: ConfigError[] = []

  switch (comp.type) {
    case "Inputs":
      if (!comp.hasExplicitId) {
        errors.push({ componentType: "Inputs", componentId: "(missing)", message: "The 'id' prop is required" })
      }
      if (!extractProp(comp.props, "path") && !comp.content.trim()) {
        errors.push({ componentType: "Inputs", componentId: comp.id, message: "Either 'path' prop or inline YAML content is required" })
      }
      break

    case "Template":
      if (!comp.hasExplicitId) {
        errors.push({ componentType: "Template", componentId: "(missing)", message: "The 'id' prop is required" })
      }
      if (!extractProp(comp.props, "path")) {
        errors.push({ componentType: "Template", componentId: comp.id, message: "The 'path' prop is required" })
      }
      break

    case "TemplateInline":
      if (!comp.hasExplicitId) {
        errors.push({ componentType: "TemplateInline", componentId: "(missing)", message: "The 'id' prop is required" })
      }
      if (!extractProp(comp.props, "outputPath")) {
        errors.push({ componentType: "TemplateInline", componentId: comp.id, message: "The 'outputPath' prop is required" })
      }
      if (!comp.content.trim()) {
        errors.push({ componentType: "TemplateInline", componentId: comp.id, message: "Template content is empty" })
      }
      break

    case "Check":
    case "Command":
    case "Finish":
      if (!comp.hasExplicitId) {
        errors.push({ componentType: comp.type, componentId: comp.id, message: "The 'id' prop is required" })
      }
      break
  }

  return errors
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTemplateContent(content: string): string {
  const codeFenceRe = /```[a-zA-Z]*\s*\n([\s\S]+?)```/
  const match = codeFenceRe.exec(content)
  if (match?.[1]) return match[1]
  return content.trim()
}

function resolveBoilerplatePath(runbookDir: string, templatePath: string): string {
  const fullPath = path.join(runbookDir, templatePath)
  if (templatePath.endsWith("boilerplate.yml")) {
    return fullPath
  }
  return path.join(fullPath, "boilerplate.yml")
}

function loadBoilerplateConfig(configPath: string): BoilerplateConfig {
  const content = fs.readFileSync(configPath, "utf-8")
  return parseConfig(content)
}

/** The Inputs block's error for unfenced inline YAML (extractYamlFromChildren). */
const MISSING_FENCE_MESSAGE =
  "Invalid inline boilerplate configuration format: please wrap your YAML content in a code fence (```yaml ... ```)"

/**
 * Returns the YAML inside an Inputs block's code fence, or null when the app
 * would reject the content as unfenced. The app reads any fence, whatever its
 * language hint. Without a fence, MDX turns YAML on its own lines into
 * paragraphs and lists, which the block rejects; only content on the same
 * line as the tags reaches it as plain text.
 */
function extractInlineYAML(content: string): string | null {
  const match = /```[^\n]*\n([\s\S]+?)```/.exec(content)
  if (match?.[1]) return match[1]
  return content.includes("\n") ? null : content.trim()
}

/**
 * Parse boilerplate YAML with the app's parser, so `required`, variable types
 * and `validations` are normalised exactly as the Inputs form sees them.
 */
function parseConfig(yamlContent: string): BoilerplateConfig {
  const result = Effect.runSync(Effect.either(parseBoilerplateConfig(yamlContent)))
  if (Either.isLeft(result)) throw result.left
  return result.right
}

export function lowercaseFirst(s: string): string {
  if (!s) return s
  return s[0].toLowerCase() + s.slice(1)
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

/**
 * Validate a test input value. The CLI checks the value's YAML type (enum
 * membership, int, bool) itself, since the form's widgets enforce those; the
 * `required` flag and `validations` rules go through the same
 * validateVariableValue the Inputs form uses.
 */
function validateValue(
  key: string,
  value: unknown,
  variable: BoilerplateVariable,
): ValidationError[] {
  const errors: ValidationError[] = []

  switch (variable.type) {
    case "enum": {
      const strVal = String(value)
      if (variable.options && !variable.options.includes(strVal)) {
        errors.push({ inputKey: key, message: `Value "${strVal}" not in enum options [${variable.options.join(", ")}]` })
      }
      break
    }

    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push({ inputKey: key, message: `Expected integer, got ${typeof value}` })
      }
      break

    case "bool":
      if (typeof value !== "boolean") {
        errors.push({ inputKey: key, message: `Expected boolean, got ${typeof value}` })
      }
      break
  }

  const message = validateVariableValue(variable, value)
  if (message) {
    // Fuzzed inputs change on every run and are only printed after validation
    // passes, so name the failing value here (unless the variable is sensitive).
    errors.push({ inputKey: key, message: variable.sensitive ? message : `${message} (got ${describeValue(value)})` })
  }

  return errors
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
