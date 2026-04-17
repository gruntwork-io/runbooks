/**
 * IPC handlers for boilerplate operations.
 *
 * Provides config parsing, template rendering, and inline template rendering.
 */
import { Cause, Effect, Exit, Fiber } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager, manifestStore } from "./runtime.ts"
import {
  parseBoilerplateConfig,
  extractOutputDependencies,
} from "../../../src/domain/boilerplate/config.ts"
import { BoilerplateRenderer } from "../../../src/services/BoilerplateRenderer.ts"
import { FileSystem } from "../../../src/services/FileSystem.ts"
import { buildFileTree } from "../../../src/domain/workspace/file-tree.ts"
import {
  buildManifestFromDirectory,
  computeDiff,
  applyDiff,
} from "../../../src/domain/files/manifest.ts"
import { resolveToAbsolutePath } from "../../../src/domain/files/generated.ts"
import type {
  RenderRequest,
  RenderInlineRequest,
  BoilerplateRequest,
} from "../../../src/types.ts"
import { validateSessionPath } from "./path-guard.ts"

/**
 * True when a value is a Go-template expression string. Such values arrive
 * from the UI because the form echoes back the unresolved `default:` from
 * `boilerplate.yml` for any variable the user hasn't overridden.
 */
const TEMPLATE_EXPR_RE = /\{\{.*?\}\}/s

function isTemplateString(v: unknown): boolean {
  return typeof v === "string" && TEMPLATE_EXPR_RE.test(v)
}

/**
 * Recursively drop any value that's still a Go-template expression. Boilerplate
 * re-evaluates `--var-file` string values as templates; passing a raw
 * `{{ .inputs.X }}` for a value crashes when the eval happens inside a
 * dependency that doesn't expose the `inputs` namespace. By stripping those
 * placeholders we force boilerplate to fall through to its own default,
 * which it evaluates correctly in the parent scope (where `inputs`/`outputs`
 * are in scope via our var-file).
 *
 * Maps/lists are descended. A map whose resulting keys are all stripped is
 * dropped entirely so the dependency's own defaults apply instead.
 */
function stripTemplateValues(value: unknown): unknown {
  if (isTemplateString(value)) return undefined
  if (Array.isArray(value)) {
    const cleaned = value
      .map(stripTemplateValues)
      .filter((v) => v !== undefined)
    return cleaned
  }
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripTemplateValues(v)
      if (stripped !== undefined) cleaned[k] = stripped
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined
  }
  return value
}

/**
 * Flatten `{ inputs: {...}, outputs: {...} }` into the shape boilerplate's
 * `--var-file` expects: each input variable lifted to the top level (for
 * legacy `{{ .X }}` syntax + the CLI's required-variable check), while
 * preserving the `inputs` and `outputs` namespaces (for new-style
 * `{{ .inputs.X }}` / `{{ .outputs.block.X }}` references).
 *
 * Explicit root-level keys win over the lifted inputs (matches main's
 * `applyBackwardCompatibility`). Reserved names `inputs` and `outputs` inside
 * the inputs namespace are skipped to avoid clobbering the namespaces.
 *
 * Template-expression values are stripped — see `stripTemplateValues`. The
 * `outputs` namespace is left untouched (its values are real block outputs,
 * not defaults, and we want boilerplate to resolve `.outputs.X.Y` refs
 * against them).
 */
function flattenVariables(
  variables: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const src = variables ?? {}

  // Strip template placeholders from `inputs` only. `outputs` is preserved
  // verbatim so real output values reach boilerplate even if they happen to
  // look template-ish.
  const rawInputs = src.inputs
  const cleanedInputs =
    rawInputs && typeof rawInputs === "object" && !Array.isArray(rawInputs)
      ? (stripTemplateValues(rawInputs) as Record<string, unknown> | undefined) ?? {}
      : {}

  const result: Record<string, unknown> = {
    ...src,
    inputs: cleanedInputs,
  }

  for (const [k, v] of Object.entries(cleanedInputs)) {
    if (k === "inputs" || k === "outputs") continue
    if (!(k in result)) result[k] = v
  }
  return result
}

/**
 * Tracks in-flight render fibers per `templateId`. When a new render starts
 * for a templateId that's already rendering, we interrupt the old fiber —
 * which kills the boilerplate subprocess via `Effect.onInterrupt` in
 * `runBoilerplate` — so rapid input edits don't queue a backlog of stale
 * renders. The interrupted call resolves to a sentinel that the renderer
 * layer can ignore (the superseding call will drive the UI state).
 */
const activeRenders = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>()

export function registerBoilerplateHandlers(): void {
  ipcMain.handle(
    "boilerplate:variables",
    async (_event, params: BoilerplateRequest) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          let yamlContent: string

          let resolvedTemplatePath: string | undefined

          if (params.boilerplateContent) {
            yamlContent = params.boilerplateContent
          } else if (params.templatePath) {
            resolvedTemplatePath = yield* validateSessionPath(params.templatePath)
            const fs = yield* FileSystem

            // If the path is a directory, look for boilerplate.yml inside it
            const stat = yield* fs.stat(resolvedTemplatePath)
            if (stat.isDirectory) {
              // Try boilerplate.yml, then boilerplate.yaml
              const ymlPath = `${resolvedTemplatePath}/boilerplate.yml`
              const yamlPath = `${resolvedTemplatePath}/boilerplate.yaml`
              const ymlExists = yield* Effect.either(fs.stat(ymlPath))
              if (ymlExists._tag === "Right") {
                resolvedTemplatePath = ymlPath
              } else {
                resolvedTemplatePath = yamlPath
              }
            }

            yamlContent = yield* fs.readFile(resolvedTemplatePath)
          } else {
            throw new Error("Either templatePath or boilerplateContent is required")
          }

          const config = yield* parseBoilerplateConfig(yamlContent)

          // Extract output dependencies from the boilerplate.yml itself.
          // Variable defaults often reference `{{ .outputs.blockId.X }}`, and
          // those deps must gate the Generate button just like refs in
          // template files do.
          const yamlDeps = extractOutputDependencies(yamlContent)
          for (const dep of yamlDeps) {
            if (!config.outputDependencies.some((d) => d.fullPath === dep.fullPath)) {
              config.outputDependencies.push(dep)
            }
          }

          // Extract output dependencies from template files if we have a path
          if (resolvedTemplatePath) {
            const fs = yield* FileSystem
            const templateDir = resolvedTemplatePath.replace(/\/[^/]+$/, "")
            const entries = yield* Effect.either(fs.readdir(templateDir))

            if (entries._tag === "Right") {
              for (const entry of entries.right) {
                if (entry === "boilerplate.yml" || entry === "boilerplate.yaml") continue
                const filePath = `${templateDir}/${entry}`
                const content = yield* Effect.either(fs.readFile(filePath))
                if (content._tag === "Right") {
                  const deps = extractOutputDependencies(content.right)
                  config.outputDependencies.push(...deps)
                }
              }
            }
          }

          return config
        }),
      )
    },
  )

  ipcMain.handle(
    "boilerplate:render",
    async (_event, params: RenderRequest) => {
      const templateId = params.templateId ?? params.templatePath
      const t0 = Date.now()
      console.log("[ipc boilerplate:render] invoked", {
        templatePath: params.templatePath,
        templateId,
        target: params.target,
        varKeys: params.variables ? Object.keys(params.variables) : [],
      })

      // Interrupt any in-flight render for this same templateId. The prior
      // fiber's Effect.onInterrupt will kill its boilerplate subprocess and
      // clean up its tempdir via the outer Effect.ensuring.
      const prior = activeRenders.get(templateId)
      if (prior) {
        console.log("[ipc boilerplate:render] superseding in-flight render", { templateId })
        await Effect.runPromise(Fiber.interrupt(prior).pipe(Effect.ignore))
      }

      const program = Effect.gen(function* () {
        const renderer = yield* BoilerplateRenderer
        const fs = yield* FileSystem

        const resolvedTemplatePath = yield* validateSessionPath(params.templatePath)

        // Resolve output directory
        const session = yield* sessionManager.getSession()
        const workingDir = session.workingDir

        let outputDir: string
        if (params.target === "worktree") {
          const workTreePath = sessionManager.getActiveWorkTreePath()
          if (!workTreePath) {
            throw new Error("No active worktree registered")
          }
          outputDir = workTreePath
        } else {
          outputDir = yield* resolveToAbsolutePath(
            workingDir,
            params.outputPath ?? "output",
          )
        }
        yield* validateSessionPath(outputDir)

        // Render the template into a tempdir, then diff-apply into the real
        // outputDir. This keeps manifest work bounded to just the files this
        // template actually produced — so it's safe (and fast) even when
        // `outputDir` is a full git worktree.
        const tempRenderDir = yield* fs.mkdtemp("boilerplate-render-")

        // Boilerplate's `--var-file` looks up variable names at the root
        // of the YAML. Our UI sends { inputs: {...}, outputs: {...} } to
        // support `{{ .inputs.X }}` / `{{ .outputs.block.X }}` template
        // syntax, but the CLI also needs each variable at the root for
        // legacy `{{ .X }}` syntax and for its own "variable has no default"
        // check. Mirror main's `applyBackwardCompatibility` behavior:
        // flatten `inputs.*` to the top level (non-destructively, so
        // explicit root-level keys win), and keep the `inputs`/`outputs`
        // namespaces intact.
        const flattenedVariables = flattenVariables(params.variables)

        const renderAndApply = Effect.gen(function* () {
          const tRender = Date.now()
          yield* renderer.renderTemplate(
            resolvedTemplatePath,
            tempRenderDir,
            flattenedVariables,
          )
          const dRender = Date.now() - tRender

          const tManifest = Date.now()
          const newEntries = yield* buildManifestFromDirectory(tempRenderDir)
          const dManifest = Date.now() - tManifest

          const oldManifest = manifestStore.get(templateId)
          const oldEntries = oldManifest?.files ?? []
          const diff = computeDiff(oldEntries, newEntries)

          const tApply = Date.now()
          const applied = yield* applyDiff(diff, tempRenderDir, outputDir)
          const dApply = Date.now() - tApply

          manifestStore.set(templateId, { templateId, outputDir, files: newEntries })

          // For worktree target the UI discards fileTree and just refreshes
          // via invalidateGitFileTree, so skip the expensive walk.
          let treeNodes: unknown[] = []
          let treeMeta: unknown = { totalFiles: 0, truncatedTree: false, heavyDirs: [] }
          const tTree = Date.now()
          if (params.target !== "worktree") {
            const built = yield* buildFileTree(outputDir)
            treeNodes = built.tree as unknown[]
            treeMeta = built.meta
          }
          const dTree = Date.now() - tTree

          console.log("[ipc boilerplate:render] timing(ms)", {
            templateId,
            render: dRender,
            manifest: dManifest,
            apply: dApply,
            tree: dTree,
            total: Date.now() - t0,
            files: newEntries.length,
            created: diff.created.length,
            modified: diff.modified.length,
            orphaned: diff.orphaned.length,
            unchanged: diff.unchanged.length,
            applied,
          })

          return {
            message: `Template rendered to ${outputDir}`,
            outputDir,
            templatePath: params.templatePath,
            fileTree: treeNodes,
            meta: treeMeta,
            deletedFiles: diff.orphaned,
            createdFiles: diff.created,
            modifiedFiles: diff.modified,
            skippedFiles: diff.unchanged,
          }
        })

        return yield* renderAndApply.pipe(
          Effect.ensuring(
            fs.rm(tempRenderDir, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        )
      })

      const fiber = runtime.runFork(program)
      activeRenders.set(templateId, fiber as Fiber.RuntimeFiber<unknown, unknown>)

      try {
        // Use Fiber.await (returns an Exit) instead of Fiber.join so we can
        // distinguish interruption (= superseded by a newer request) from a
        // real failure. Superseded calls resolve to a sentinel that the
        // client's useApi treats as "ignore, the newer call will update UI".
        const exit = await runtime.runPromise(Fiber.await(fiber))
        if (Exit.isSuccess(exit)) {
          return exit.value
        }
        if (Cause.isInterruptedOnly(exit.cause)) {
          console.log("[ipc boilerplate:render] superseded, discarding result", {
            templateId,
            elapsed: Date.now() - t0,
          })
          return { superseded: true } as const
        }
        throw Cause.squash(exit.cause)
      } finally {
        // Only clear if *our* fiber is still the registered one — a superseding
        // call may have already registered a newer fiber under this templateId.
        if (activeRenders.get(templateId) === (fiber as Fiber.RuntimeFiber<unknown, unknown>)) {
          activeRenders.delete(templateId)
        }
      }
    },
  )

  ipcMain.handle(
    "boilerplate:render-inline",
    async (_event, params: RenderInlineRequest) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const renderer = yield* BoilerplateRenderer
          const fs = yield* FileSystem

          // Build variables record from inputs
          const variables: Record<string, unknown> = {}
          for (const input of params.inputs) {
            variables[input.name] = input.value
          }

          // Render each template file
          const renderedFiles: Record<string, any> = {}
          for (const [name, templateContent] of Object.entries(params.templateFiles)) {
            const rendered = yield* renderer.renderFile(templateContent, variables)
            renderedFiles[name] = {
              name,
              path: name,
              content: rendered,
              language: "",
              size: rendered.length,
              isTruncated: false,
            }
          }

          // Optionally write to disk
          if (params.generateFile && params.outputPath) {
            const session = yield* sessionManager.getSession()
            const outputDir = yield* resolveToAbsolutePath(
              session.workingDir,
              params.outputPath,
            )

            yield* validateSessionPath(outputDir)
            yield* fs.mkdir(outputDir, { recursive: true })

            for (const [name, rendered] of Object.entries(renderedFiles)) {
              const filePath = `${outputDir}/${name}`
              yield* fs.writeFile(filePath, (rendered as any).content)
            }
          }

          return {
            message: "Inline template rendered",
            renderedFiles,
            fileTree: [],
            meta: { totalFiles: 0, truncatedTree: false, heavyDirs: [] },
          }
        }),
      )
    },
  )
}
