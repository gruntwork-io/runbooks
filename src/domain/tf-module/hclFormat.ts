/**
 * Lines up the `=` of consecutive attributes the way `hcl fmt` and
 * `tofu fmt` do, so code rendered from a template whose inputs come and go
 * is formatted however many of them it has.
 */

/** An attribute line: indentation, name, and the value after `=`. */
const ATTRIBUTE = /^(\s*)([A-Za-z_][\w-]*)\s*=(?!=)\s*(.*)$/

/** A value that goes on past its line, so the attribute ends a run. */
const OPENS = /(?:[{[(]|<<-?\s*([A-Za-z_]\w*))\s*$/

/** Whether `path` names a file in HCL's native syntax. */
export function isHclFile(path: string): boolean {
  return /\.(?:hcl|tf|tfvars)$/.test(path)
}

/**
 * The text with each run of attributes aligned: consecutive lines at the
 * same indentation that assign a value. A blank line, a comment, a block,
 * or a line at another indentation ends a run; an attribute whose value
 * goes on to the next lines is the last of its run. Heredoc bodies are left
 * as they are.
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
    const [, indent = "", name = "", value = ""] = match
    if (run.length > 0 && run[0]!.indent !== indent) flush()
    run.push({ index, indent, name, value: value.trimEnd() })
    const opens = OPENS.exec(value.trimEnd())
    if (opens) {
      heredoc = opens[1]
      flush()
    }
  }
  if (run.length > 0) flush()
  return lines.join("\n")
}
