/**
 * IPC handlers for boilerplate operations.
 *
 * Provides config parsing, template rendering, and inline template rendering.
 */
import path from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager, manifestStore } from "./runtime.ts"
import {
  parseBoilerplateConfig,
  extractOutputDependencies,
} from "../../../src/domain/boilerplate/config.ts"
import { BoilerplateRenderer } from "../../../src/services/BoilerplateRenderer.ts"
import { FileSystem } from "../../../src/services/FileSystem.ts"
import { WarmRenderDispatcher } from "../../../src/services/WarmRenderDispatcher.ts"
import { buildFileTree } from "../../../src/domain/workspace/file-tree.ts"
import {
  buildManifestFromDirectory,
  computeDiff,
  applyDiff,
  applyDiffFromContent,
  hashFileContent,
} from "../../../src/domain/files/manifest.ts"
import { resolveToAbsolutePath } from "../../../src/domain/files/generated.ts"
import type { ManifestEntry } from "../../../src/types.ts"
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
 * for a templateId that's already rendering, we interrupt the old fiber.
 *
 * What "interrupt" actually does depends on which path the prior fiber took:
 *
 *  - **Cold path** (subprocess): `Effect.onInterrupt` in `runBoilerplate`
 *    SIGKILLs the boilerplate child process and removes its tempdir,
 *    reclaiming real CPU. This was the original supersession design.
 *  - **Warm path** (in-process WASM): the WASM bridge has no
 *    cancellation hook, so the in-flight `boilerplateRenderFiles` call
 *    continues on the Go runtime's goroutine until it returns. The
 *    `serialize()` chain in `NodeWasmRuntime` already queues the next
 *    WASM call behind it, so ordering is correct. The interrupted
 *    fiber's post-render work (manifest diff / write / file-tree walk)
 *    is skipped — that's the savings on this path, on the order of
 *    tens of ms per superseded render rather than the hundreds of ms
 *    a SIGKILL'd subprocess reclaims.
 *
 * Either way, the interrupted call resolves to a `superseded` sentinel that
 * the renderer-side `useApi` ignores, so the latest call drives the UI.
 */
const activeRenders = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>()

/**
 * Per-templateId start times for renders currently in flight. Used to estimate
 * how much wall-clock work was thrown away when a render is superseded —
 * proxy for "wasted CPU" so we can tune the renderer debounce against it.
 */
const renderStartTimes = new Map<string, number>()

/**
 * Cumulative supersession stats per templateId, for the lifetime of this
 * main-process instance. Reported on every render so you can eyeball trends
 * (e.g. supersessions spike when debounce is lowered).
 */
interface SupersessionStats {
  /** Times a newer render killed an in-flight render for this templateId. */
  count: number
  /** Total wall time of work thrown away (ms). */
  wastedMs: number
}
const supersessionStats = new Map<string, SupersessionStats>()

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
      const perf = params.perf
      const perfTag = perf ? `[perf seq=${perf.seq}]` : ""
      const ipcTransit = perf ? t0 - perf.sentAt : undefined
      const sinceKeystroke = perf ? t0 - perf.keystrokeAt : undefined
      console.log("[ipc boilerplate:render] invoked", {
        templatePath: params.templatePath,
        templateId,
        target: params.target,
        varKeys: params.variables ? Object.keys(params.variables) : [],
        ...(perf ? { perfSeq: perf.seq, ipcTransitMs: ipcTransit, sinceKeystrokeMs: sinceKeystroke } : {}),
      })

      // Interrupt any in-flight render for this same templateId. See the
      // `activeRenders` doc-comment above for what "interrupt" means on
      // warm vs cold paths.
      const prior = activeRenders.get(templateId)
      if (prior) {
        const priorStartedAt = renderStartTimes.get(templateId)
        const wastedMs = priorStartedAt ? t0 - priorStartedAt : 0
        const stats = supersessionStats.get(templateId) ?? { count: 0, wastedMs: 0 }
        stats.count += 1
        stats.wastedMs += wastedMs
        supersessionStats.set(templateId, stats)
        console.log("[ipc boilerplate:render] superseding in-flight render", {
          templateId,
          killedAfterMs: wastedMs,
          totalSupersedeCount: stats.count,
          totalWastedMs: stats.wastedMs,
        })
        await Effect.runPromise(Fiber.interrupt(prior).pipe(Effect.ignore))
      }
      renderStartTimes.set(templateId, t0)

      // Tracked at this scope so the Effect.ensuring finalizer below can
      // clean it up even when the fiber is interrupted mid-render.
      const tempDirRef: { path: string | null } = { path: null }

      const program = Effect.gen(function* () {
        const renderer = yield* BoilerplateRenderer
        const fs = yield* FileSystem
        const warmDispatcher = yield* WarmRenderDispatcher

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

        const tFlatten = Date.now()
        const flattenedVariables = flattenVariables(params.variables)
        const dFlatten = Date.now() - tFlatten

        // ---------- Warm attempt ----------
        // If WASM is configured + loaded AND the bundle's analyzer
        // produced output paths, we render entirely in-process. The
        // dispatcher returns a per-file partition: warm-success, paths
        // that must fall back to cold, paths excluded by skip_files, and
        // template-execution errors to surface to the user.
        const tWarm = Date.now()
        const warmResult = yield* warmDispatcher.render(
          templateId,
          resolvedTemplatePath,
          flattenedVariables,
        ).pipe(
          // Any warm-path failure (loader/bundle producer/structural) is
          // recoverable — fall through to the cold path. We don't want a
          // WASM init bug to break renders.
          Effect.catchAll((err) =>
            Effect.sync(() => {
              console.log("[ipc boilerplate:render] warm path errored, falling back to cold", {
                templateId,
                error: (err as { message?: string }).message ?? String(err),
              })
              return {
                files: [],
                coldNeeded: [],
                skipped: [],
                renderErrors: [],
                warmDisabled: true,
                disabledReason: "warm-error-fallback",
              } as const
            })
          ),
        )
        const dWarm = Date.now() - tWarm

        const needsCold = warmResult.warmDisabled || warmResult.coldNeeded.length > 0

        // Short-circuit when the dirty-set computation found no changes
        // (e.g., the user pressed a non-mutating key, or a downstream
        // re-render fired with identical vars). Reuse the previous
        // manifest, skip every subprocess, return immediately.
        if (warmResult.noChanges && !warmResult.warmDisabled) {
          const prevManifestEntries = manifestStore.get(templateId)?.files ?? []
          const dTotal = Date.now() - t0
          console.log("[ipc boilerplate:render] timing(ms)", {
            templateId,
            path: "noop",
            total: dTotal,
            files: prevManifestEntries.length,
            ...(perf ? {
              perfSeq: perf.seq,
              ipcTransitMs: ipcTransit,
              sinceKeystrokeMs: Date.now() - perf.keystrokeAt,
            } : {}),
          })
          return {
            message: `Template up-to-date (no var changes)`,
            outputDir,
            templatePath: params.templatePath,
            fileTree: [],
            meta: { totalFiles: 0, truncatedTree: false, heavyDirs: [] },
            deletedFiles: [] as string[],
            createdFiles: [] as string[],
            modifiedFiles: [] as string[],
            skippedFiles: prevManifestEntries.map((e) => e.path),
          }
        }

        // Build the in-memory content map. Warm-success files seed it;
        // cold renders (when needed) fill in the rest by reading from a
        // tempdir.
        const contentMap = new Map<string, string>()
        for (const file of warmResult.files) {
          contentMap.set(file.path, file.content)
        }

        let dCold = 0
        let dRender = 0

        if (needsCold) {
          // ---------- Cold fallback ----------
          // Run the full subprocess render into a tempdir. We then merge
          // its output into the content map for every path the warm
          // attempt did NOT successfully render — that's coldNeeded plus
          // (in the warm-disabled case) every path the subprocess produced.
          const tMkdtemp = Date.now()
          const createdTempDir = yield* fs.mkdtemp("boilerplate-render-")
          tempDirRef.path = createdTempDir
          const dMkdtemp = Date.now() - tMkdtemp

          const tRenderInner = Date.now()
          yield* renderer.renderTemplate(
            resolvedTemplatePath,
            createdTempDir,
            flattenedVariables,
          )
          dRender = Date.now() - tRenderInner

          // Read every file the subprocess wrote into our content map,
          // but only for paths warm didn't successfully render — we
          // deliberately preserve warm content where it succeeded so a
          // future build of boilerplate-fast that fixes more analyzer
          // edge cases keeps the warm win.
          const coldEntries = yield* buildManifestFromDirectory(createdTempDir)
          const missing = coldEntries.filter((e) => !contentMap.has(e.path))
          const reads = yield* Effect.forEach(
            missing,
            (entry) =>
              fs.readFile(path.join(createdTempDir, entry.path)).pipe(
                Effect.map((content) => [entry.path, content] as const),
              ),
            { concurrency: 16 },
          )
          for (const [p, content] of reads) contentMap.set(p, content)
          dCold = dMkdtemp + dRender
        }

        // ---------- Manifest + diff + apply ----------
        // We only re-rendered the dirty subset (plus, when needed, the
        // full cold tree). The manifest must cover the FULL set of files
        // this template produces, not just what we touched this call —
        // otherwise unchanged files appear as orphaned and we delete
        // them from disk.
        //
        // Universe of paths = (rendered this time) ∪ (previous manifest)
        //                   ∪ (analyzer's known set).
        // For each path:
        //   - In contentMap → use the freshly-computed hash
        //   - Else in prev manifest → carry forward the prev hash (file
        //     wasn't re-rendered because no relevant var changed)
        //   - Else (analyzer ghost: in `files` but never produced) → skip
        const tManifest = Date.now()
        const oldManifest = manifestStore.get(templateId)
        const oldEntries = oldManifest?.files ?? []
        const prevByPath = new Map<string, string>()
        for (const e of oldEntries) prevByPath.set(e.path, e.contentHash)

        const universe = new Set<string>()
        for (const p of warmResult.allKnownPaths) universe.add(p)
        for (const p of contentMap.keys()) universe.add(p)
        for (const p of prevByPath.keys()) universe.add(p)

        const newEntries: ManifestEntry[] = []
        for (const path of universe) {
          if (contentMap.has(path)) {
            newEntries.push({ path, contentHash: hashFileContent(contentMap.get(path)!) })
          } else if (prevByPath.has(path)) {
            newEntries.push({ path, contentHash: prevByPath.get(path)! })
          }
          // else: analyzer ghost — never rendered, no prev. Skip.
        }
        newEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        const dManifest = Date.now() - tManifest

        const diff = computeDiff(oldEntries, newEntries)

        const tApply = Date.now()
        // Pure warm: write content directly. Cold-fallback: same — we
        // already merged everything into contentMap above. Either way we
        // bypass the tempdir-copy logic in `applyDiff` for the write
        // step. (Cleanup of the tempdir, if we made one, happens below.)
        const applied = yield* applyDiffFromContent(diff, contentMap, outputDir)
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

        const dTotal = Date.now() - t0
        const cumStats = supersessionStats.get(templateId) ?? { count: 0, wastedMs: 0 }
        console.log("[ipc boilerplate:render] timing(ms)", {
          templateId,
          flatten: dFlatten,
          warm: dWarm,
          cold: dCold,
          render: dRender,
          manifest: dManifest,
          apply: dApply,
          tree: dTree,
          total: dTotal,
          path: warmResult.warmDisabled
            ? `cold (${warmResult.disabledReason ?? "unknown"})`
            : warmResult.coldNeeded.length > 0
              ? `hybrid (warm=${warmResult.files.length}, cold=${warmResult.coldNeeded.length})`
              : "warm",
          files: newEntries.length,
          created: diff.created.length,
          modified: diff.modified.length,
          orphaned: diff.orphaned.length,
          unchanged: diff.unchanged.length,
          applied,
          warmFiles: warmResult.files.length,
          warmColdNeeded: warmResult.coldNeeded.length,
          warmSkipped: warmResult.skipped.length,
          warmRenderErrors: warmResult.renderErrors.length,
          // Dirty-set sizing — useful for spotting cases where we
          // accidentally render the world (attempted ≈ known) and
          // cases where the savings actually land (attempted << known).
          warmAttempted: warmResult.attemptedPaths.length,
          warmKnown: warmResult.allKnownPaths.length,
          // Cumulative since main-process start. Useful for tuning the
          // renderer-side debounce: rising wasted_ms means typists are
          // outrunning the binary and we're paying for killed work.
          supersedeCount: cumStats.count,
          supersedeWastedMs: cumStats.wastedMs,
          ...(perf ? {
            perfSeq: perf.seq,
            ipcTransitMs: ipcTransit,
            sinceKeystrokeMs: Date.now() - perf.keystrokeAt,
          } : {}),
        })
        if (perf) {
          console.log(`${perfTag} [perf main] boilerplate:render done`, {
            totalSinceKeystrokeMs: Date.now() - perf.keystrokeAt,
            handlerMs: dTotal,
            warmMs: dWarm,
            coldMs: dCold,
          })
        }
        if (warmResult.renderErrors.length > 0) {
          // Surface template-bug errors via the existing log channel.
          // The UI doesn't render these inline today (we don't have a
          // per-file error surface yet), but they're visible in dev for
          // debugging template authors' mistakes.
          console.log("[ipc boilerplate:render] template render errors", {
            templateId,
            errors: warmResult.renderErrors,
          })
        }

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
      }).pipe(
        // Tempdir cleanup. Runs on success, failure, and interruption (a
        // superseding render). Returns void either way so failures don't
        // mask a real render error.
        Effect.ensuring(
          Effect.gen(function* () {
            if (tempDirRef.path) {
              const fs = yield* FileSystem
              yield* fs.rm(tempDirRef.path, { recursive: true, force: true }).pipe(Effect.ignore)
              tempDirRef.path = null
            }
          }).pipe(Effect.ignore),
        ),
      )

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
          renderStartTimes.delete(templateId)
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
