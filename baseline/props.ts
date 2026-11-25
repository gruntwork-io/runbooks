/**
 * The props each block's docs page lists today, read from the page's
 * "Props" sections: bullet lists (`- \`name\` (type): ...`) and tables
 * (`| \`name\` | ...`). The frozen copy is `props.json`; regenerate it on
 * purpose with `bun baseline/props.ts`, never to make a check pass.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const DOCS_DIR = path.resolve(import.meta.dir, "../docs/src/content/docs/authoring/blocks")
export const FROZEN = path.resolve(import.meta.dir, "props.json")

const HEADING = /^(#{2,6})\s+(.*)$/
const BULLET = /^\s*-\s+`([A-Za-z][A-Za-z0-9]*)`\s+\(/
const ROW = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/

/** The props one page documents, in the order it lists them. */
export function propsOnPage(markdown: string): string[] {
  const props: string[] = []
  let inProps = false
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence
    if (inFence) continue
    const heading = HEADING.exec(line)
    if (heading) {
      inProps = /\bprops\b/i.test(heading[2]!)
      continue
    }
    if (!inProps) continue
    const name = BULLET.exec(line)?.[1] ?? ROW.exec(line)?.[1]
    if (name !== undefined && !props.includes(name)) props.push(name)
  }
  return props
}

/**
 * Pages that document their props in a sentence: "accepts the same props as
 * <GitAuth> except provider and hideProviderSelect".
 */
const SAME_PROPS_AS: Record<
  string,
  { readonly as: string; readonly except: ReadonlyArray<string> }
> = {
  GitLabAuth: { as: "GitAuth", except: ["provider", "hideProviderSelect"] },
  GitLabMergeRequest: { as: "GitPullRequest", except: ["provider"] },
}

/** Every documented tag and its props, keyed by tag. */
export function documentedProps(dir: string = DOCS_DIR): Record<string, string[]> {
  const pages: Record<string, string[]> = {}
  for (const file of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    const tag = file.replace(/\.mdx?$/, "")
    if (tag === file || tag === "index") continue
    pages[tag] = propsOnPage(readFileSync(path.join(dir, file), "utf8"))
  }
  const result: Record<string, string[]> = {}
  for (const [tag, props] of Object.entries(pages)) {
    const same = SAME_PROPS_AS[tag]
    if (props.length > 0) result[tag] = props
    else if (same) result[tag] = (pages[same.as] ?? []).filter((p) => !same.except.includes(p))
    else throw new Error(`${tag}: no props found under a "Props" heading in ${dir}`)
  }
  return result
}

if (import.meta.main) {
  writeFileSync(FROZEN, `${JSON.stringify(documentedProps(), null, 2)}\n`)
  console.log(`Wrote ${path.relative(process.cwd(), FROZEN)}`)
}
