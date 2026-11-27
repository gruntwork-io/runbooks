/**
 * A block's "Script changed" notice: how the files it names differ on disk
 * from the text the session holds, which the block keeps until they are
 * reloaded (`BlockView.filesOnDisk`), as the old app's `ScriptChangeNotice`
 * showed a script's. The frame draws it in any block that has them,
 * whatever its class, a misconfigured one too, and in instruction mode,
 * where an instruction shows the text the session holds. It folds with its
 * block, as the old app's did.
 *
 * The diff (`script-change-diff`, as the old app's) is each file's hunks,
 * each under the line it starts at on either side, and each line signed as
 * a unified diff signs it: `-` for the text the session holds, `+` for the
 * text on disk, a space for context. A file the session can't take as it
 * is shows why. A file with no hunks differs only in line endings, a final
 * newline or its mode, or is empty, unless a cut diff ends in it.
 *
 * "Reload script" asks the engine, as the person, to take the files at the
 * hash the notice shows (`Following.reload`). It is off while the engine is
 * asked, and once it took them, until the page draws the runbook that holds
 * them, which the session's `DocumentChanged` brings and in which the
 * block shows no notice. Under it, the last answer, while the notice shows
 * the files it was for: they changed again (`NotShown`), and a newer diff
 * follows; the blocks that were running (`Running`), each a link to its
 * frame, since the engine reloads nothing while a block runs and keeps no
 * ask for later; or why the ask failed. A cut diff says beside the button
 * that the button takes the whole change. Instruction mode runs nothing
 * and changes nothing, whatever the block's class: the notice shows its
 * diff with no button, and says how to reload.
 */
import { Effect } from "effect"
import { useContext } from "react"
import type { BlockView, FilesOnDisk } from "@runbooks/core/protocol"
import { BlockLink } from "./blockLink.tsx"
import { FollowingContext, useDocument, useInstructionMode, useReloading } from "./following.ts"
import { reloadOver, type Reloading } from "./reload.ts"

type FileOnDisk = FilesOnDisk["files"][number]
type Changed = Extract<FileOnDisk, { readonly _tag: "Changed" }>
type DiffLine = Changed["hunks"][number]["lines"][number]

export function ScriptChange({
  block,
  onDisk,
  onPage,
}: {
  readonly block: BlockView["block"]
  readonly onDisk: FilesOnDisk
  /** The blocks the page draws a frame for, which a running block's id links to. */
  readonly onPage: ReadonlySet<string>
}) {
  const following = useContext(FollowingContext)
  const instructionMode = useInstructionMode()
  const answer = reloadOver(useReloading(block), onDisk, useDocument())
  const last = onDisk.files.length - 1
  return (
    <section className="script-change" aria-label="Script changed">
      <p className="script-change-title">
        <strong>Script changed</strong>
      </p>
      <p>
        The files below changed on disk since Runbooks read them. Until you reload the script, the
        block keeps the version Runbooks read. Review the change first.
      </p>
      <div className="script-change-diff" data-testid="script-change-diff">
        {onDisk.files.map((file, index) => (
          <FileDiff key={file.path} file={file} cut={onDisk.truncated === true && index === last} />
        ))}
      </div>
      <div className="script-change-actions">
        {instructionMode ? (
          <p>Turn off instruction mode to reload the script.</p>
        ) : (
          <button
            type="button"
            className="script-reload"
            disabled={answer?._tag === "Asking" || answer?._tag === "Reloaded"}
            onClick={() => Effect.runFork(following.reload(block, onDisk.hash))}
          >
            Reload script
          </button>
        )}
        {onDisk.truncated === true ? (
          <span className="script-change-cut">
            {instructionMode
              ? "The diff is cut short: the change goes on past it."
              : "The diff is cut short. Reload script takes the whole change, the part not shown too."}
          </span>
        ) : null}
      </div>
      {answer === undefined ? null : <Answer answer={answer} onPage={onPage} />}
    </section>
  )
}

/** What the notice says of the last answer, under its button. */
function Answer({
  answer,
  onPage,
}: {
  readonly answer: Reloading["answer"]
  readonly onPage: ReadonlySet<string>
}) {
  switch (answer._tag) {
    // The button is off until the page draws the runbook that took them.
    case "Asking":
    case "Reloaded":
      return null
    case "NotShown":
      return (
        <p className="script-change-said">
          The files changed again. The newer change shows here once Runbooks reads it.
        </p>
      )
    case "Running":
      return (
        <div className="script-change-said">
          <p>
            The script didn't reload: nothing reloads while a block runs. Reload it once these stop:
          </p>
          <ul>
            {answer.blocks.map((running) => (
              <li key={running}>
                <BlockLink block={running} onPage={onPage} />
              </li>
            ))}
          </ul>
        </div>
      )
    case "Failed":
      return <p className="script-change-said">{answer.line}</p>
    default: {
      const unhandled: never = answer
      throw new Error(`The notice has no words for ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** One file's part of the diff. `cut`: the diff was cut in it. */
function FileDiff({ file, cut }: { readonly file: FileOnDisk; readonly cut: boolean }) {
  if (file._tag === "Unreadable")
    return (
      <div className="diff-file">
        <p className="diff-path">{file.reason}</p>
      </div>
    )
  return (
    <div className="diff-file">
      <p className="diff-path">
        <code>{file.path}</code>
        {` ${changed(file.change)}`}
      </p>
      {file.hunks.length > 0 || cut ? null : (
        <p>
          {file.change === "modified"
            ? "Its lines are the same: only line endings, a final newline or the file's mode differ."
            : "It is empty."}
        </p>
      )}
      {file.hunks.map((hunk, index) => (
        <pre key={index} className="diff-hunk">
          {[`@@ -${hunk.heldLine} +${hunk.diskLine} @@`, ...hunk.lines.map(signed)].join("\n")}
        </pre>
      ))}
    </div>
  )
}

/** What happened to a file, after its path. */
function changed(change: Changed["change"]): string {
  switch (change) {
    case "modified":
      return "changed"
    case "created":
      return "is new"
    case "deleted":
      return "was deleted"
    default: {
      const unhandled: never = change
      throw new Error(`The notice has no words for the change ${String(unhandled)}.`)
    }
  }
}

/** A line as a unified diff shows it. */
function signed(line: DiffLine): string {
  switch (line.kind) {
    case "context":
      return ` ${line.text}`
    case "deletion":
      return `-${line.text}`
    case "addition":
      return `+${line.text}`
    default: {
      const unhandled: never = line.kind
      throw new Error(`The notice has no sign for the line ${String(unhandled)}.`)
    }
  }
}
