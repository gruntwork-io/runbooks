/**
 * Renders the small templates runbook_block.yml uses to label a lookup's rows and
 * fill other inputs from a pick, such as
 * `{{ .domainName }}{{ if .isPrimary }} (primary){{ end }}`.
 *
 * The syntax is the subset of Go templates these need: `{{ .field }}`, and
 * `{{ if .field }}...{{ else }}...{{ end }}`, without nesting. It runs in the
 * renderer for every row as the user types, so it can't go through the
 * boilerplate engine; anything else in `{{ }}` is an error, so a template
 * that uses more than this fails loudly instead of rendering wrong.
 */

export type LookupRow = Readonly<Record<string, unknown>>

const TOKEN = /\{\{-?\s*(.*?)\s*-?\}\}/g
const FIELD = /^\.([A-Za-z_][\w]*)$/
const IF = /^if\s+(\.[A-Za-z_][\w]*)$/

/** A row field's text: empty for a missing or null field. */
function fieldText(row: LookupRow, name: string): string {
  const value = row[name]
  if (value === undefined || value === null) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

/** Whether a row field counts as true in an `if`: Go's truthiness. */
function truthy(row: LookupRow, name: string): boolean {
  const value = row[name]
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0
  return Boolean(value)
}

/** Renders `template` against `row`. Throws on syntax it doesn't support. */
export function renderRowTemplate(template: string, row: LookupRow): string {
  let out = ""
  // While inside an `if`: whether its branch is the one being written.
  let branch: { writing: boolean; sawElse: boolean } | undefined
  let last = 0
  for (const match of template.matchAll(TOKEN)) {
    const text = template.slice(last, match.index)
    if (!branch || branch.writing) out += text
    last = match.index + match[0].length

    const action = match[1]!
    const field = FIELD.exec(action)
    const condition = IF.exec(action)
    if (field) {
      if (!branch || branch.writing) out += fieldText(row, field[1]!)
    } else if (condition) {
      if (branch) throw new Error(`Nested "if" isn't supported in "${template}".`)
      branch = { writing: truthy(row, condition[1]!.slice(1)), sawElse: false }
    } else if (action === "else") {
      if (!branch || branch.sawElse) throw new Error(`Unexpected "else" in "${template}".`)
      branch = { writing: !branch.writing, sawElse: true }
    } else if (action === "end") {
      if (!branch) throw new Error(`Unexpected "end" in "${template}".`)
      branch = undefined
    } else {
      throw new Error(
        `"{{ ${action} }}" isn't supported in "${template}"; use {{ .field }} or {{ if .field }}.`,
      )
    }
  }
  if (branch) throw new Error(`"if" without "end" in "${template}".`)
  return out + template.slice(last)
}

/** Checks a template's syntax without a row, for reporting a bad runbook_block.yml early. */
export function rowTemplateError(template: string): string | undefined {
  try {
    renderRowTemplate(template, {})
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** The fields a template reads, in the order it first reads them. */
export function templateFields(template: string): string[] {
  const fields: string[] = []
  for (const match of template.matchAll(TOKEN)) {
    const action = match[1]!
    const name = FIELD.exec(action)?.[1] ?? IF.exec(action)?.[1]?.slice(1)
    if (name && !fields.includes(name)) fields.push(name)
  }
  return fields
}
