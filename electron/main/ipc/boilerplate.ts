/**
 * IPC handlers for boilerplate operations.
 *
 * Provides config parsing, template rendering, and inline template rendering.
 */
import { Effect } from "effect"
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
} from "../../../src/domain/files/manifest.ts"
import { resolveToAbsolutePath } from "../../../src/domain/files/generated.ts"
import type {
  RenderRequest,
  RenderInlineRequest,
  BoilerplateRequest,
} from "../../../src/types.ts"

export function registerBoilerplateHandlers(): void {
  ipcMain.handle(
    "boilerplate:variables",
    async (_event, params: BoilerplateRequest) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          let yamlContent: string

          if (params.boilerplateContent) {
            yamlContent = params.boilerplateContent
          } else if (params.templatePath) {
            const fs = yield* FileSystem
            yamlContent = yield* fs.readFile(params.templatePath)
          } else {
            throw new Error("Either templatePath or boilerplateContent is required")
          }

          const config = yield* parseBoilerplateConfig(yamlContent)

          // Extract output dependencies from template files if we have a path
          if (params.templatePath) {
            const fs = yield* FileSystem
            const templateDir = params.templatePath.replace(/\/[^/]+$/, "")
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
      return runtime.runPromise(
        Effect.gen(function* () {
          const renderer = yield* BoilerplateRenderer
          const fs = yield* FileSystem

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

          // Get old manifest for diff detection
          const templateId = params.templateId ?? params.templatePath
          const oldManifest = manifestStore.get(templateId)
          const oldEntries = oldManifest?.files ?? []

          // Render the template
          yield* renderer.renderTemplate(
            params.templatePath,
            outputDir,
            params.variables,
          )

          // Build new manifest and compute diff
          const newEntries = yield* buildManifestFromDirectory(outputDir)
          const diff = computeDiff(oldEntries, newEntries)

          // Delete orphaned files
          for (const orphanedPath of diff.orphaned) {
            const fullPath = `${outputDir}/${orphanedPath}`
            yield* fs.rm(fullPath, { force: true }).pipe(Effect.ignore)
          }

          // Update manifest store
          manifestStore.set(templateId, {
            templateId,
            outputDir,
            files: newEntries,
          })

          // Build file tree for the response
          const fileTree = yield* buildFileTree(outputDir)

          return {
            message: `Template rendered to ${outputDir}`,
            outputDir,
            templatePath: params.templatePath,
            fileTree: fileTree.tree,
            meta: fileTree.meta,
            deletedFiles: diff.orphaned,
            createdFiles: diff.created,
            modifiedFiles: diff.modified,
            skippedFiles: diff.unchanged,
          }
        }),
      )
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
