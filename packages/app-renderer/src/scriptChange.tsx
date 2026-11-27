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
 */
import type { FilesOnDisk } from "@runbooks/core/protocol"

type FileOnDisk = FilesOnDisk["files"][number]
type Changed = Extract<FileOnDisk, { readonly _tag: "Changed" }>
type DiffLine = Changed["hunks"][number]["lines"][number]

export function ScriptChange({ onDisk }: { readonly onDisk: FilesOnDisk }) {
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
    </section>
  )
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
