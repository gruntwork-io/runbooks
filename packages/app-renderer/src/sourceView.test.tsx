import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { ScriptFiles } from "@runbooks/core/protocol"
import type { ScriptFilesShown } from "./scriptFiles.ts"
import { linesIn, SourceCode } from "./sourceView.tsx"

// A block's source view, "View Source Code", rendered to the markup the
// page would hold: closed, and open with what the window read.

const READ = Schema.decodeUnknownSync(ScriptFiles)({
  document: `sha256:${"1".repeat(64)}`,
  files: [
    { path: "lib/util.sh", language: "bash", text: "echo util\n" },
    {
      path: "greet.sh",
      language: "bash",
      text: '#!/bin/bash\necho "{{ .inputs.token }}" <done>\n',
    },
  ],
})
const [UTIL, GREET] = READ.files
if (GREET === undefined || UTIL === undefined) throw new Error("READ names two files")
const GREET_SH = GREET.path

const drawn = (open: boolean, shown: ScriptFilesShown | undefined, path = GREET_SH) =>
  renderToStaticMarkup(<SourceCode path={path} open={open} shown={shown} onToggle={() => {}} />)

describe("a block's source view", () => {
  it("is closed at first: the file's path and the toggle, and none of its text", () => {
    const shown = drawn(false, { _tag: "Read", files: READ.files })
    expect(shown).toContain('<section class="source-view" aria-label="Source of greet.sh">')
    expect(shown).toContain('<button type="button" aria-expanded="false">View Source Code</button>')
    expect(shown).toContain('<span class="source-view-path">Path: <code>greet.sh</code></span>')
    expect(shown).not.toContain("echo")
    expect(shown).not.toContain("Language")
  })

  it("shows the script's language, its lines and its text, as the author wrote it, once open", () => {
    const shown = drawn(true, { _tag: "Read", files: READ.files })
    expect(shown).toContain('aria-expanded="true"')
    expect(shown).toContain(
      '<dl class="source-view-facts"><dt>Language</dt><dd><code>bash</code></dd><dt>Lines</dt><dd>2</dd></dl>',
    )
    expect(shown).toContain(
      '<pre class="source-view-code" aria-label="Source code"><code class="language-bash">#!/bin/bash\necho &quot;{{ .inputs.token }}&quot; &lt;done&gt;\n</code></pre>',
    )
    // The block's other file is not this one.
    expect(shown).not.toContain("echo util")
  })

  it.each([
    ["before the window read it", undefined],
    ["while the window reads it", { _tag: "Reading" } as const],
  ])("says it is reading the script %s", (_, read) => {
    const shown = drawn(true, read)
    expect(shown).toContain('<p class="source-view-note">Reading the script.</p>')
    expect(shown).not.toContain("source-view-code")
  })

  it("says why it shows no script when the window could not read it", () => {
    const line = "This runbook's session closed, so its script files can't be shown."
    expect(drawn(true, { _tag: "Failed", line })).toContain(
      '<p class="source-view-note">This runbook&#x27;s session closed, so its script files can&#x27;t be shown.</p>',
    )
  })

  it("says the block no longer names the file when what the window read lacks it", () => {
    const shown = drawn(true, { _tag: "Read", files: [UTIL] })
    expect(shown).toContain('<p class="source-view-note">The block no longer names this file.</p>')
  })

  it.each([
    ["", 0],
    ["echo hi", 1],
    ["echo hi\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["a\n\n", 2],
  ])("counts the lines of %j as %d", (text, lines) => {
    expect(linesIn(text)).toBe(lines)
  })
})
