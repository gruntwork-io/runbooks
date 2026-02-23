// ============================================================================
// Template Processor - Main pipeline orchestrator
// Ported from templates/template_processor.go
// ============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { renderTemplate } from '../../template-renderer'
import { loadBoilerplateConfig } from '../config/config'
import { renderVariables } from '../render/render-variables'
import { convertVariablesToTypes } from '../variables/convert-type'
import type {
  BoilerplateConfig,
  BoilerplateOptions,
  Hook,
  LogEntry,
} from '../../../shared/types'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

type LogCallback = (entry: LogEntry) => void

function log(cb: LogCallback | undefined, level: LogEntry['level'], message: string): void {
  cb?.({
    timestamp: new Date().toISOString(),
    level,
    message,
  })
}

/**
 * Process a boilerplate template: load config, resolve variables, render files.
 */
export async function processTemplate(
  opts: BoilerplateOptions,
  onLog?: LogCallback
): Promise<{ filesWritten: string[]; errors: string[] }> {
  const filesWritten: string[] = []
  const errors: string[] = []

  try {
    // 1. Load config
    log(onLog, 'info', `Loading config from ${opts.templateFolder}`)
    const config = loadBoilerplateConfig(opts.templateFolder)

    // 2. Resolve variables with defaults and multi-trial rendering
    log(onLog, 'info', 'Resolving variables...')
    const resolvedVars = resolveVariables(config, opts.vars)

    // 3. Execute before hooks
    if (config.hooks.before.length > 0) {
      log(onLog, 'info', `Executing ${config.hooks.before.length} before hook(s)...`)
      await executeHooks(config.hooks.before, resolvedVars, opts, onLog)
    }

    // 4. Process template files
    log(onLog, 'info', `Processing template files from ${opts.templateFolder}`)
    const templateDir = opts.templateFolder
    const outputDir = opts.outputFolder

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true })

    // Walk template directory and process files
    const templateFiles = walkDirectory(templateDir)

    for (const filePath of templateFiles) {
      const relativePath = path.relative(templateDir, filePath)

      // Skip boilerplate.yml itself
      if (relativePath === 'boilerplate.yml') continue

      // Skip hidden files/dirs
      if (relativePath.split(path.sep).some((p) => p.startsWith('.'))) continue

      // Check skip_files
      if (shouldSkipFile(relativePath, config, resolvedVars)) {
        log(onLog, 'debug', `Skipping: ${relativePath}`)
        continue
      }

      try {
        // Render the output path (paths can contain template expressions)
        const renderedRelPath = renderOutputPath(relativePath, resolvedVars)
        const outputPath = path.join(outputDir, renderedRelPath)

        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })

        // Check if file is text (renderable) or binary (copy as-is)
        if (isTextFile(filePath)) {
          const contents = fs.readFileSync(filePath, 'utf-8')
          const rendered = renderTemplate(contents, resolvedVars)
          fs.writeFileSync(outputPath, rendered)
          log(onLog, 'info', `Rendered: ${renderedRelPath}`)
        } else {
          fs.copyFileSync(filePath, outputPath)
          log(onLog, 'info', `Copied: ${renderedRelPath}`)
        }

        filesWritten.push(renderedRelPath)
      } catch (err) {
        const msg = `Error processing ${relativePath}: ${err instanceof Error ? err.message : err}`
        log(onLog, 'error', msg)
        errors.push(msg)
      }
    }

    // 5. Execute after hooks
    if (config.hooks.after.length > 0) {
      log(onLog, 'info', `Executing ${config.hooks.after.length} after hook(s)...`)
      await executeHooks(config.hooks.after, resolvedVars, opts, onLog)
    }

    log(onLog, 'info', `Done! ${filesWritten.length} file(s) written to ${outputDir}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(onLog, 'error', msg)
    errors.push(msg)
  }

  return { filesWritten, errors }
}

/**
 * Resolve variables: apply defaults, references, and multi-trial rendering.
 */
function resolveVariables(
  config: BoilerplateConfig,
  userVars: Record<string, unknown>
): Record<string, unknown> {
  // Start with user-provided variables
  const vars: Record<string, unknown> = { ...userVars }

  // Apply defaults for variables not provided by user
  for (const variable of config.variables) {
    if (vars[variable.name] === undefined) {
      // Handle references
      if (variable.reference && vars[variable.reference] !== undefined) {
        vars[variable.name] = vars[variable.reference]
      } else if (variable.default !== undefined) {
        vars[variable.name] = variable.default
      }
    }
  }

  // Separate variables into those needing rendering and those already resolved
  const needsRendering: Record<string, unknown> = {}
  const alreadyRendered: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === 'string' && value.includes('{{')) {
      needsRendering[name] = value
    } else if (value !== undefined && value !== null) {
      // Check if nested values contain templates
      if (hasTemplateExpressions(value)) {
        needsRendering[name] = value
      } else {
        alreadyRendered[name] = value
      }
    }
  }

  // Multi-trial render
  let rendered: Record<string, unknown>
  if (Object.keys(needsRendering).length > 0) {
    rendered = renderVariables(needsRendering, alreadyRendered)
  } else {
    rendered = alreadyRendered
  }

  // Convert types according to config
  return convertVariablesToTypes(rendered, config.variables)
}

function hasTemplateExpressions(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{')
  if (Array.isArray(value)) return value.some(hasTemplateExpressions)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(hasTemplateExpressions)
  }
  return false
}

/**
 * Execute hooks via child_process.
 */
async function executeHooks(
  hooks: Hook[],
  vars: Record<string, unknown>,
  opts: BoilerplateOptions,
  onLog?: LogCallback
): Promise<void> {
  for (const hook of hooks) {
    // Check skip condition
    if (hook.skip) {
      try {
        const skipResult = renderTemplate(`{{ ${hook.skip} }}`, vars)
        if (skipResult === 'true') {
          log(onLog, 'debug', `Skipping hook: ${hook.command}`)
          continue
        }
      } catch {
        // If skip evaluation fails, don't skip
      }
    }

    // Render command and args
    const command = renderTemplate(hook.command, vars)
    const args = hook.args.map((arg) => renderTemplate(arg, vars))

    // Build environment
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    for (const [key, val] of Object.entries(hook.env)) {
      env[key] = renderTemplate(val, vars)
    }

    // Add template variables
    env['outputFolder'] = opts.outputFolder
    env['templateFolder'] = opts.templateFolder

    const fullCommand = [command, ...args].join(' ')
    log(onLog, 'info', `Running hook: ${fullCommand}`)

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        cwd: hook.workingDir || opts.templateFolder,
        env,
      })
      if (stdout) log(onLog, 'info', stdout.trim())
      if (stderr) log(onLog, 'warn', stderr.trim())
    } catch (err) {
      const msg = `Hook failed: ${fullCommand}: ${err instanceof Error ? err.message : err}`
      log(onLog, 'error', msg)
      throw new Error(msg)
    }
  }
}

/**
 * Check if a file should be skipped based on skip_files config.
 */
function shouldSkipFile(
  relativePath: string,
  config: BoilerplateConfig,
  vars: Record<string, unknown>
): boolean {
  for (const skipFile of config.skipFiles) {
    const matches = skipFile.path
      ? matchGlob(relativePath, skipFile.path)
      : !matchGlob(relativePath, skipFile.notPath)

    if (matches) {
      // Check conditional
      if (skipFile.if) {
        try {
          const result = renderTemplate(`{{ ${skipFile.if} }}`, vars)
          if (result === 'true') return true
        } catch {
          // If condition can't be evaluated, don't skip
        }
      } else {
        return true
      }
    }
  }
  return false
}

/**
 * Simple glob matching (supports * and **).
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(filePath)
}

/**
 * Render a file path through the template engine.
 * Ported from template_processor.go:outPath
 */
function renderOutputPath(relativePath: string, vars: Record<string, unknown>): string {
  // URL-decode the path
  let decoded: string
  try {
    decoded = decodeURIComponent(relativePath)
  } catch {
    decoded = relativePath
  }

  // Render through template engine if it contains template expressions
  if (decoded.includes('{{')) {
    return renderTemplate(decoded, vars)
  }

  return decoded
}

/**
 * Walk a directory recursively and return all file paths.
 */
function walkDirectory(dir: string): string[] {
  const files: string[] = []

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  }

  walk(dir)
  return files
}

/**
 * Check if a file is text (renderable) vs binary.
 */
function isTextFile(filePath: string): boolean {
  const textExtensions = new Set([
    '.txt', '.md', '.yml', '.yaml', '.json', '.js', '.ts', '.jsx', '.tsx',
    '.html', '.css', '.scss', '.less', '.xml', '.svg', '.sh', '.bash',
    '.zsh', '.fish', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.pl', '.pm', '.r',
    '.tf', '.hcl', '.toml', '.ini', '.cfg', '.conf', '.env', '.gitignore',
    '.dockerignore', '.editorconfig', '.prettierrc', '.eslintrc',
    '.Dockerfile', '.Makefile', '.cmake', '.gradle', '.properties',
    '.sql', '.graphql', '.proto', '.tmpl', '.tpl', '.j2',
  ])

  const ext = path.extname(filePath).toLowerCase()

  // Check extension first
  if (textExtensions.has(ext)) return true

  // Files with no extension are often text (Makefile, Dockerfile, etc.)
  if (ext === '') {
    const basename = path.basename(filePath)
    const textFiles = new Set([
      'Makefile', 'Dockerfile', 'Vagrantfile', 'Gemfile', 'Rakefile',
      'LICENSE', 'README', 'CHANGELOG', 'CONTRIBUTING',
    ])
    if (textFiles.has(basename)) return true
  }

  // Try reading first few bytes to detect binary
  try {
    const buffer = Buffer.alloc(512)
    const fd = fs.openSync(filePath, 'r')
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0)
    fs.closeSync(fd)

    // Check for null bytes (binary indicator)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return false
    }
    return true
  } catch {
    return false
  }
}
