/**
 * Reads an OpenTofu module from a folder into the spec a <TfModule> block
 * draws its form from.
 */
import * as path from "path"
import { Effect } from "effect"
import { TfModuleError } from "../../errors/index.ts"
import { isContainedInReal } from "../../path-validation.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { loadDeclarations } from "../lookups/load.ts"
import { moduleLookupUses } from "../lookups/module.ts"
import { checkDefinitions } from "../lookups/validate.ts"
import {
  METADATA_FILE,
  buildSpec,
  tfOutputs,
  parseHcl,
  parseMetadata,
  parsePresets,
  readmeTitle,
  requiredProviders,
  tfVariables,
  type ModuleFile,
} from "./spec.ts"
import type { TfModulePreset, TfModuleSpec } from "./types.ts"

/** The image types a module's logo can be, by extension. */
const LOGO_TYPES: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}

/** A logo bigger than this is a mistake, and would bloat every IPC reply. */
const MAX_LOGO_BYTES = 256 * 1024

/**
 * The configuration files OpenTofu reads: every .tf and .tofu file, except a
 * .tf file whose .tofu twin exists, which OpenTofu reads instead.
 */
export function configFileNames(names: readonly string[]): string[] {
  const tofu = new Set(
    names.filter((name) => name.endsWith(".tofu")).map((name) => name.slice(0, -5)),
  )
  return names
    .filter(
      (name) => name.endsWith(".tofu") || (name.endsWith(".tf") && !tofu.has(name.slice(0, -3))),
    )
    .sort()
}

/**
 * A file the module names, such as its presets or logo, which must stay
 * inside the module: a module is someone else's code, and its runbook_block.yml
 * must not read files elsewhere on the user's computer.
 */
const fileInModule = (moduleDir: string, relative: string, what: string) =>
  Effect.gen(function* () {
    const resolved = path.resolve(moduleDir, relative)
    const inside = yield* Effect.promise(() => isContainedInReal(resolved, moduleDir))
    if (path.isAbsolute(relative) || !inside) {
      return yield* new TfModuleError({
        message: `${METADATA_FILE} names ${what} "${relative}", which is outside the module.`,
      })
    }
    return resolved
  })

const readModuleFile = (file: string, what: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    return yield* fs
      .readFile(file)
      .pipe(
        Effect.mapError(
          () => new TfModuleError({ message: `Couldn't read ${what} ${path.basename(file)}.` }),
        ),
      )
  })

const readOptional = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    if (!(yield* fs.exists(file))) return undefined
    return yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => undefined))
  })

/** The logo runbook_block.yml names, as a URL the form can show. */
const readLogo = (moduleDir: string, logo: string) =>
  Effect.gen(function* () {
    if (logo.startsWith("https://")) return logo
    const type = LOGO_TYPES[path.extname(logo).toLowerCase()]
    if (!type) {
      return yield* new TfModuleError({
        message: `${METADATA_FILE} names the logo "${logo}"; use an SVG, PNG, JPEG or WebP file, or an https: URL.`,
      })
    }
    const file = yield* fileInModule(moduleDir, logo, "the logo")
    const fs = yield* FileSystem
    const bytes = yield* fs
      .readFileBuffer(file)
      .pipe(
        Effect.mapError(() => new TfModuleError({ message: `Couldn't read the logo "${logo}".` })),
      )
    if (bytes.length > MAX_LOGO_BYTES) {
      return yield* new TfModuleError({
        message: `The logo "${logo}" is bigger than ${MAX_LOGO_BYTES / 1024} KB.`,
      })
    }
    return `data:${type};base64,${bytes.toString("base64")}`
  })

/**
 * The lookups and checks runbook_block.yml defines and includes, checked
 * against each other, the inputs' uses of them, and the module's inputs. A
 * problem fails the module, since a form with a broken lookup would fail only
 * once someone used it.
 */
const moduleDefinitions = (moduleDir: string, doc: unknown, inputs: readonly string[]) =>
  Effect.gen(function* () {
    const file = path.join(moduleDir, METADATA_FILE)
    const loaded = yield* loadDeclarations(doc, file)
    const { uses } = moduleLookupUses(doc, file)
    const problems = [
      ...loaded.problems,
      ...checkDefinitions(loaded.definitions, {
        lookups: uses,
        preflight: loaded.preflight,
        inputs,
        source: file,
      }),
    ]
    if (problems.length > 0) {
      return yield* new TfModuleError({
        message: `${METADATA_FILE}: ${problems.map((problem) => problem.message).join(" ")}`,
      })
    }
    return { definitions: loaded.definitions, preflight: loaded.preflight }
  })

/** Reads the module in `moduleDir`. Fails with a message fit to show the user. */
export const loadModule = (moduleDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const stat = yield* fs
      .stat(moduleDir)
      .pipe(
        Effect.mapError(() => new TfModuleError({ message: `There's no module at ${moduleDir}.` })),
      )
    if (!stat.isDirectory) {
      return yield* new TfModuleError({
        message: `${moduleDir} is a file; a module is a folder.`,
      })
    }

    const entries = yield* fs
      .readdirWithTypes(moduleDir)
      .pipe(
        Effect.mapError(
          () => new TfModuleError({ message: `Couldn't list the files in ${moduleDir}.` }),
        ),
      )
    const names = configFileNames(
      entries.filter((entry) => entry.isFile).map((entry) => entry.name),
    )
    if (names.length === 0) {
      return yield* new TfModuleError({
        message: `${moduleDir} has no .tf or .tofu files, so it isn't an OpenTofu module.`,
      })
    }

    const files: ModuleFile[] = yield* Effect.forEach(names, (name) =>
      readModuleFile(path.join(moduleDir, name), "the module file").pipe(
        Effect.map((content) => ({ name, content })),
      ),
    )
    const parsed = yield* Effect.forEach(files, parseHcl)

    const metadataText = yield* readOptional(path.join(moduleDir, METADATA_FILE))
    const metadata = yield* Effect.try({
      try: () => parseMetadata(metadataText),
      catch: (cause) =>
        cause instanceof TfModuleError
          ? cause
          : new TfModuleError({ message: String(cause), cause }),
    })

    const presetFiles = [
      ...new Set(
        Object.values(metadata.variables).flatMap((meta) => (meta.presets ? [meta.presets] : [])),
      ),
    ]
    const presets: Record<string, readonly TfModulePreset[]> = {}
    for (const relative of presetFiles) {
      const file = yield* fileInModule(moduleDir, relative, "the presets file")
      const content = yield* readModuleFile(file, "the presets file")
      presets[relative] = yield* Effect.try({
        try: () => parsePresets(content, relative),
        catch: (cause) =>
          cause instanceof TfModuleError
            ? cause
            : new TfModuleError({ message: String(cause), cause }),
      })
    }

    const variables = tfVariables(parsed, files)
    const { definitions, preflight } = yield* moduleDefinitions(
      moduleDir,
      metadata.doc,
      variables.map((variable) => variable.name),
    )

    const logo = metadata.logo ? yield* readLogo(moduleDir, metadata.logo) : undefined
    const readme = entries.find(
      (entry) => entry.isFile && /^readme\.(md|markdown)$/i.test(entry.name),
    )
    const title = readme
      ? readmeTitle(yield* readOptional(path.join(moduleDir, readme.name)))
      : undefined

    return yield* Effect.try({
      try: (): TfModuleSpec =>
        buildSpec({
          moduleName: path.basename(moduleDir),
          ...(title ? { readmeTitle: title } : {}),
          outputs: tfOutputs(parsed, files),
          variables,
          providers: requiredProviders(parsed),
          metadata,
          presets,
          definitions,
          preflight,
          ...(logo ? { logo } : {}),
        }),
      catch: (cause) =>
        cause instanceof TfModuleError
          ? cause
          : new TfModuleError({ message: String(cause), cause }),
    })
  })
