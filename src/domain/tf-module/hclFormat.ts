/**
 * Lines up the `=` of consecutive attributes the way `hcl fmt` and
 * `tofu fmt` do, so code rendered from a template whose inputs come and go
 * is formatted however many of them it has.
 */

/**
 * An attribute line: indentation, name or quoted key, and the value after
 * `=`. A `==` comparison or a `=>` in a `for` expression isn't one.
 */
const ATTRIBUTE = /^(\s*)([A-Za-z_][\w-]*|"(?:[^"\\]|\\.)*")\s*=(?![=>])\s*(.*)$/

/** A value that opens a bracket it closes on a later line. */
const OPENS_BRACKET = /[{[(]\s*$/

/** A value that starts a heredoc, with the word that ends it. */
const OPENS_HEREDOC = /<<-?\s*([A-Za-z_]\w*)\s*$/

/** Whether `path` names a file in HCL's native syntax. */
export function isHclFile(path: string): boolean {
  return /\.(?:hcl|tf|tofu|tfvars)$/.test(path)
}

/**
 * The text with each run of attributes aligned: consecutive lines at the
 * same indentation that assign a value. A blank line, a comment, a block,
 * or a line at another indentation ends a run. An attribute whose value
 * opens a bracket on its line stands alone, as `hcl fmt` leaves it; one
 * that starts a heredoc stays in its run, and the heredoc's body is left
 * as it is.
 */
export function alignAttributes(text: string): string {
  const lines = text.split("\n")
  let run: { index: number; indent: string; name: string; value: string }[] = []
  let heredoc: string | undefined

  const flush = () => {
    const width = Math.max(...run.map((a) => a.name.length))
    for (const a of run) lines[a.index] = `${a.indent}${a.name.padEnd(width)} = ${a.value}`
    run = []
  }

  for (const [index, line] of lines.entries()) {
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) heredoc = undefined
      continue
    }
    const match = ATTRIBUTE.exec(line)
    if (!match) {
      flush()
      continue
    }
    const [, indent = "", name = "", rest = ""] = match
    const value = rest.trimEnd()
    if (run.length > 0 && run[0]!.indent !== indent) flush()
    if (OPENS_BRACKET.test(value)) {
      flush()
      lines[index] = `${indent}${name} = ${value}`
      continue
    }
    run.push({ index, indent, name, value })
    heredoc = OPENS_HEREDOC.exec(value)?.[1]
  }
  if (run.length > 0) flush()
  return lines.join("\n")
}
