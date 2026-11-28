/**
 * A block's source view, "View Source Code", as the old app's Command
 * showed it for a script file (`web/src/components/mdx/_shared/components/
 * ScriptBlock.tsx`, `ViewSourceCode.tsx`): the file's path and a toggle,
 * closed at first, and once open the script's language, its lines and its
 * text. The frame draws one for each script file a block names
 * (`DocumentBlock.scriptFiles`); an inline script has none, as in the old app.
 *
 * The text is what the session holds, the text a run runs, as the author
 * wrote it: a `{{ }}` in it is text. A closed view reads nothing, so the
 * language and the lines show once it is open (`scriptFiles.ts`).
 */
import { useContext, useEffect, useState } from "react"
import type { BlockView, ScriptFile } from "@runbooks/core/protocol"
import { FollowingContext, useScriptFiles } from "./following.ts"
import type { ScriptFilesShown } from "./scriptFiles.ts"

type RunbookPath = ScriptFile["path"]

/** The source view of the script file at `path` that `block` names. */
export function SourceView({
  block,
  path,
}: {
  readonly block: BlockView["block"]
  readonly path: RunbookPath
}) {
  const [open, setOpen] = useState(false)
  const { scriptFiles } = useContext(FollowingContext)
  useEffect(() => (open ? scriptFiles.open(block) : undefined), [open, block, scriptFiles])
  const shown = useScriptFiles(block)
  return <SourceCode path={path} open={open} shown={shown} onToggle={() => setOpen(!open)} />
}

/** The view itself, as `SourceView` draws it: closed, or open with what the window read. */
export function SourceCode({
  path,
  open,
  shown,
  onToggle,
}: {
  readonly path: RunbookPath
  readonly open: boolean
  /** What the window read of the block's script files; nothing until it reads them. */
  readonly shown: ScriptFilesShown | undefined
  readonly onToggle: () => void
}) {
  return (
    <section className="source-view" aria-label={`Source of ${path}`}>
      <div className="source-view-head">
        <button type="button" aria-expanded={open} onClick={onToggle}>
          View Source Code
        </button>
        <span className="source-view-path">
          Path: <code>{path}</code>
        </span>
      </div>
      {open ? <Source path={path} shown={shown} /> : null}
    </section>
  )
}

function Source({
  path,
  shown,
}: {
  readonly path: RunbookPath
  readonly shown: ScriptFilesShown | undefined
}) {
  if (shown === undefined) return <p className="source-view-note">Reading the script.</p>
  switch (shown._tag) {
    case "Reading":
      return <p className="source-view-note">Reading the script.</p>
    case "Failed":
      return <p className="source-view-note">{shown.line}</p>
    case "Read": {
      const script = shown.files.find((file) => file.path === path)
      if (script === undefined)
        return <p className="source-view-note">The block no longer names this file.</p>
      return (
        <>
          <dl className="source-view-facts">
            <dt>Language</dt>
            <dd>
              <code>{script.language}</code>
            </dd>
            <dt>Lines</dt>
            <dd>{linesIn(script.text)}</dd>
          </dl>
          <pre className="source-view-code" aria-label="Source code">
            <code className={`language-${script.language}`}>{script.text}</code>
          </pre>
        </>
      )
    }
    default: {
      const unhandled: never = shown
      throw new Error(`The source view has nothing to show for ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** The lines in `text`: a line break ends a line, and text after the last one is a line too. */
export function linesIn(text: string): number {
  if (text === "") return 0
  const breaks = text.split("\n").length - 1
  return text.endsWith("\n") ? breaks : breaks + 1
}
