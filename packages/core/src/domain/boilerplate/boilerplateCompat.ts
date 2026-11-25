/**
 * A boilerplate.yml the Boilerplate CLI accepts, for one that uses options
 * only Runbooks reads.
 *
 * Boilerplate parses `options` itself: it must be a list of strings, and an
 * enum's value must be one of them. Runbooks also takes an enum's `options`
 * as `{ value, label }` entries, or as a block output that holds the list
 * (see options.ts). The form has already checked the value against those
 * options, so Boilerplate is given a config it can parse: labelled options
 * become their values, and an enum whose options come from an output becomes
 * a `string`. A list's `x-options` needs nothing, since Boilerplate ignores
 * x-extensions.
 *
 * Boilerplate reads the config from the template directory, so a template
 * that needs this is rendered from a copy of it with the config rewritten
 * (goFacingTemplateDir).
 */

import * as path from "node:path"
import { Effect, Stream } from "effect"
import YAML from "yaml"

import { errorMessage } from "../../errors/message.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { parseOptionsReference } from "./options.ts"
import { hashTemplateDir } from "./templateHash.ts"

const CONFIG_NAMES = ["boilerplate.yml", "boilerplate.yaml"] as const

/** A template URL that names a local path, which Boilerplate resolves against the template directory. */
function isRelativeLocalPath(url: string): boolean {
  return !path.isAbsolute(url) && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("git@")
}

/**
 * `yamlContent` rewritten so Boilerplate accepts its `options`, or undefined
 * when it already does. The copy lives elsewhere, so a relative local path the
 * config names (a dependency's `template-url`, a `partials` glob) is made
 * absolute against `templateDir`. Anything Boilerplate would reject anyway is
 * left for it to report.
 */
export function boilerplateCompatibleConfig(
  yamlContent: string,
  templateDir: string,
): string | undefined {
  let doc: YAML.Document
  try {
    doc = YAML.parseDocument(yamlContent)
  } catch {
    return undefined
  }
  if (doc.errors.length > 0) return undefined

  const variables = doc.get("variables")
  if (!YAML.isSeq(variables)) return undefined

  let changed = false
  for (const variable of variables.items) {
    if (!YAML.isMap(variable)) continue
    const type = variable.get("type")
    if (typeof type !== "string" || type.toLowerCase() !== "enum") continue
    const options = variable.get("options")
    if (typeof options === "string" && parseOptionsReference(options)) {
      variable.set("type", "string")
      variable.delete("options")
      changed = true
    } else if (YAML.isSeq(options) && options.items.some(YAML.isMap)) {
      options.items = options.items.map((item) =>
        YAML.isMap(item) && typeof item.get("value") === "string"
          ? doc.createNode(item.get("value"))
          : item,
      )
      changed = true
    }
  }
  if (!changed) return undefined

  const absolute = (value: unknown) =>
    typeof value === "string" && isRelativeLocalPath(value)
      ? path.resolve(templateDir, value)
      : value
  const dependencies = doc.get("dependencies")
  if (YAML.isSeq(dependencies)) {
    for (const dependency of dependencies.items) {
      if (YAML.isMap(dependency)) {
        dependency.set("template-url", absolute(dependency.get("template-url")))
      }
    }
  }
  const partials = doc.get("partials")
  if (YAML.isSeq(partials)) {
    partials.items = partials.items.map((item) =>
      YAML.isScalar(item) ? doc.createNode(absolute(item.value)) : item,
    )
  }
  return doc.toString()
}

/** The copies made so far, by template directory: the copy and the hash of the files it was made from. */
const copies = new Map<string, { hash: string; dir: string }>()

/**
 * The directory to hand Boilerplate for `templateDir`: the directory itself,
 * or, when its config needs rewriting (boilerplateCompatibleConfig), a copy
 * with the rewritten config. A copy is made again only when the template's
 * files change, so the same path keeps the warm render's cache.
 *
 * Best-effort: a template whose config can't be read or rewritten, or whose
 * copy fails, is handed over as it is, and Boilerplate reports what it rejects.
 */
export function goFacingTemplateDir(templateDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem

    let configName: string | undefined
    let content: string | undefined
    for (const name of CONFIG_NAMES) {
      const read = yield* fs.readFile(path.join(templateDir, name)).pipe(Effect.result)
      if (read._tag === "Success") {
        configName = name
        content = read.success
        break
      }
    }
    if (configName === undefined || content === undefined) return templateDir

    const rewritten = boilerplateCompatibleConfig(content, templateDir)
    if (rewritten === undefined) return templateDir

    const contentHash = yield* hashTemplateDir(templateDir)
    const existing = copies.get(templateDir)
    if (existing?.hash === contentHash) return existing.dir

    const copied = yield* copyWithConfig(templateDir, configName, rewritten).pipe(Effect.result)
    if (copied._tag === "Failure") {
      console.warn(
        `[boilerplate] can't copy ${templateDir} to rewrite its options for Boilerplate: ${errorMessage(copied.failure)}`,
      )
      return templateDir
    }
    if (existing) yield* fs.rm(existing.dir, { recursive: true, force: true }).pipe(Effect.ignore)
    copies.set(templateDir, { hash: contentHash, dir: copied.success })
    return copied.success
  })
}

/** A copy of `templateDir` in a new temp directory, with `config` as its `configName`. */
function copyWithConfig(templateDir: string, configName: string, config: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem
    const dir = yield* fs.mkdtemp("boilerplate-template-")
    const entries = yield* fs.walk(templateDir).pipe(Stream.runCollect)
    for (const entry of entries) {
      const target = path.join(dir, entry.relativePath)
      if (entry.isDirectory) yield* fs.mkdir(target, { recursive: true })
      // A file, or a link, which copying follows as Boilerplate's reading does
      else yield* fs.copyFile(entry.path, target).pipe(Effect.ignore)
    }
    yield* fs.writeFile(path.join(dir, configName), config)
    return dir
  })
}
