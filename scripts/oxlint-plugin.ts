/**
 * The new tree's own lint rules, loaded by oxlint as a JS plugin
 * (.oxlintrc.json `jsPlugins`).
 *
 * no-relative-import-across-packages: a relative import may not cross a
 * package boundary in either direction. The compiler already refuses a
 * package the importer does not reference; this closes the gap it leaves, a
 * relative path into a referenced package's files that it does not export.
 * Packages import each other by name: `@runbooks/<package>/<export>`.
 */
import path from "node:path"
import { packageOf } from "./packages.ts"

const ROOT = path.resolve(import.meta.dirname, "..")

interface Node {
  readonly source?: { readonly type: string; readonly value: unknown } | null
}

interface Context {
  readonly filename: string
  report(problem: { node: unknown; messageId: string; data: Record<string, string> }): void
}

const where = (name: string | undefined) => name ?? "outside the packages"

const noRelativeImportAcrossPackages = {
  meta: {
    type: "problem",
    docs: { description: "A relative import may not cross a package boundary" },
    messages: {
      crosses:
        "{{spec}} crosses from {{from}} into {{to}}. Import a package by name, as @runbooks/<package>/<export>, from a package that references it.",
    },
    schema: [],
  },
  create(context: Context) {
    const file = path.relative(ROOT, context.filename)
    const from = packageOf(file)
    const check = (node: Node) => {
      const source = node.source
      if (source?.type !== "Literal" || typeof source.value !== "string") return
      const spec = source.value
      if (!spec.startsWith("./") && !spec.startsWith("../")) return
      const to = packageOf(path.relative(ROOT, path.resolve(path.dirname(context.filename), spec)))
      if (to === from) return
      context.report({
        node: source,
        messageId: "crosses",
        data: { spec, from: where(from), to: where(to) },
      })
    }
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportExpression: check,
    }
  },
}

export default {
  meta: { name: "runbooks" },
  rules: { "no-relative-import-across-packages": noRelativeImportAcrossPackages },
}
