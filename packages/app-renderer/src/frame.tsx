/**
 * `BlockFrame`: the one frame the walk draws every block in. It draws what
 * the block's class decides, and no block's view draws any of it:
 *
 * - the header: the progress step mark, the tag, the id and the title, and
 *   the description under it;
 * - a misconfigured block's errors, each with its line, in place of its
 *   view;
 * - its status, as the engine has it (`following.ts`), and what it waits
 *   for: each block it waits for is a link that scrolls to that block's
 *   frame, when the page draws one;
 * - folding: a task or credential block that asks to (`autoCollapse`)
 *   folds to its header each time it is done, and opens when the person
 *   opens it. A form never folds, nor a display block, which is never done;
 * - the body: the class's default view.
 *
 * Classes, statuses, blockers and errors are closed sets: each switch over
 * one names every member, so a new one fails the build here.
 */
import { type ReactNode, useState } from "react"
import type { BlockView, DocumentBlock } from "@runbooks/core/protocol"
import { useBlockView } from "./following.ts"
import { place } from "./place.ts"

type Configured = Extract<DocumentBlock, { readonly _tag: "Configured" }>
type BlockStatus = NonNullable<BlockView["status"]>
type Blocker = Extract<BlockStatus, { readonly _tag: "Blocked" }>["by"][number]
type Capability = Extract<Blocker, { readonly _tag: "WaitingFor" }>["capability"]
type Failure = Extract<BlockStatus, { readonly _tag: "Failed" }>["error"]

/** The element id of a block's frame, which a link to the block scrolls to. */
const frameId = (block: string): string => `runbook-block-${block}`

/** Scrolls the frame of `block` to the middle of the window, as the old app's `BlockLink` does. */
export function scrollToBlock(
  document: {
    readonly getElementById: (
      id: string,
    ) => { readonly scrollIntoView: (options: ScrollIntoViewOptions) => void } | null
  },
  block: string,
) {
  document.getElementById(frameId(block))?.scrollIntoView({ behavior: "smooth", block: "center" })
}

/** Whether a block of `kind` folds once done, when it asks to. */
function foldsWhenDone(kind: DocumentBlock["class"]): boolean {
  switch (kind) {
    case "task":
    case "credential":
      return true
    // A form's values stay in view for the blocks below that read them.
    case "form":
    // A display block has no lifecycle, so it is never done.
    case "display":
      return false
    default: {
      const unhandled: never = kind
      throw new Error(`The frame has no folding for the class ${String(unhandled)}.`)
    }
  }
}

export function BlockFrame({
  block,
  runbook,
  onPage,
  children,
}: {
  readonly block: DocumentBlock
  /** The runbook file, which the block's errors are located in. */
  readonly runbook: string
  /** The ids of the blocks the page draws a frame for, which a blocker's link may scroll to. */
  readonly onPage: ReadonlySet<string>
  /** The block's markdown children, rendered. */
  readonly children: ReactNode
}) {
  const status = useBlockView(block.id)?.status
  const done = status?._tag === "Done"
  const folds =
    block._tag === "Configured" && block.autoCollapse === true && foldsWhenDone(block.class)
  // Opened by the person since it was last done. Each time it is done, or no longer, it starts folded again.
  const [opened, setOpened] = useState(false)
  const [wasDone, setWasDone] = useState(done)
  if (wasDone !== done) {
    setWasDone(done)
    setOpened(false)
  }
  const folded = folds && done && !opened
  return (
    <section
      className="block"
      aria-label={`<${block.tag}> block`}
      id={block.id === undefined ? undefined : frameId(block.id)}
      data-folded={folded}
    >
      <header className="block-header">
        {block._tag === "Configured" && block.step ? <StepMark done={done} /> : null}
        <code className="block-tag">{`<${block.tag}>`}</code>
        {block.id === undefined ? null : <span className="block-id">{block.id}</span>}
        {block.title === undefined ? null : <span className="block-title">{block.title}</span>}
        {folds && done ? (
          <button
            type="button"
            className="block-fold"
            aria-expanded={!folded}
            onClick={() => setOpened(folded)}
          >
            {folded ? "Open" : "Fold"}
          </button>
        ) : null}
      </header>
      {folded ? null : (
        <>
          {block.description === undefined ? null : (
            <p className="block-description">{block.description}</p>
          )}
          {block._tag === "Misconfigured" ? (
            <ul className="block-errors" aria-label="Configuration errors">
              {block.errors.map((error, index) => (
                <li key={index}>{`${place(error.location, runbook)}: ${error.message}`}</li>
              ))}
            </ul>
          ) : (
            <>
              {status === undefined ? null : <Status status={status} onPage={onPage} />}
              <Body block={block}>{children}</Body>
            </>
          )}
        </>
      )}
    </section>
  )
}

/** Whether a progress step is done, as a mark at the head of its frame. */
function StepMark({ done }: { readonly done: boolean }) {
  return (
    <span
      className="block-step"
      role="img"
      aria-label={done ? "Step: done" : "Step: not done"}
      data-done={done}
    >
      {done ? "✓" : "○"}
    </span>
  )
}

/** A block's status, in words. */
function Status({
  status,
  onPage,
}: {
  readonly status: BlockStatus
  readonly onPage: ReadonlySet<string>
}) {
  switch (status._tag) {
    case "Idle":
      return <p className="block-status">Ready</p>
    case "Blocked":
      return <Blockers by={status.by} onPage={onPage} />
    case "NeedsInput":
      return <p className="block-status">{`Needs input: ${status.fields.join(", ")}`}</p>
    case "Running":
      return <p className="block-status">Running</p>
    case "Done":
      return (
        <p className="block-status">
          {status.outcome === "success" ? "Done" : "Done, with warnings"}
        </p>
      )
    case "Failed":
      return <p className="block-status">{failure(status.error)}</p>
    case "Misconfigured":
      return <p className="block-status">Its configuration has errors, so it doesn't run.</p>
    default: {
      const unhandled: never = status
      throw new Error(`The frame has no words for the status ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** Why a block did not finish, in words. */
function failure(error: Failure): string {
  switch (error._tag) {
    case "TaskFailed":
      return error.exitCode === undefined
        ? `Failed: ${error.message}`
        : `Failed: ${error.message} (exit code ${error.exitCode})`
    case "TaskCancelled":
      return "Cancelled"
    case "TaskTimedOut":
      return `Timed out after ${Math.round(error.afterMillis / 1000)} seconds`
    case "PropError":
      return `Failed: \`${error.prop}\` ${error.message}`
    case "TaskBlocked":
      return `Failed: it was blocked by ${error.by.join(", ")}`
    case "PathOutsideRoot":
    case "CredentialError":
      return `Failed: ${error.message}`
    default: {
      const unhandled: never = error
      throw new Error(`The frame has no words for the failure ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** What a block needs of a block it waits for, after that block's id. */
function need(capability: Capability): string {
  switch (capability) {
    case "values":
      return "to have its values"
    case "run":
    case "env":
      return "to run successfully"
    case "git-credential":
      return "to sign in to Git"
    case "repository":
      return "to clone its repository"
    default: {
      const unhandled: never = capability
      throw new Error(`The frame has no words for the capability ${String(unhandled)}.`)
    }
  }
}

/** What a blocked block waits for: trust, and each block it reads, as a link to it. */
function Blockers({
  by,
  onPage,
}: {
  readonly by: ReadonlyArray<Blocker>
  readonly onPage: ReadonlySet<string>
}) {
  let untrusted = false
  const waiting: Array<Extract<Blocker, { readonly _tag: "WaitingFor" }>> = []
  for (const blocker of by)
    switch (blocker._tag) {
      case "Untrusted":
        untrusted = true
        break
      case "WaitingFor":
        waiting.push(blocker)
        break
      default: {
        const unhandled: never = blocker
        throw new Error(`The frame has no words for the blocker ${JSON.stringify(unhandled)}.`)
      }
    }
  return (
    <div className="block-blockers">
      {untrusted ? <p>Waiting for you to trust this runbook.</p> : null}
      {waiting.length === 0 ? null : (
        <>
          <p>Waiting for:</p>
          <ul>
            {waiting.map(({ block, capability }) => (
              <li key={`${block} ${capability}`}>
                <BlockLink block={block} onPage={onPage} /> {need(capability)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** A block's id: a link that scrolls to its frame, or its text when the page draws none. */
function BlockLink({
  block,
  onPage,
}: {
  readonly block: string
  readonly onPage: ReadonlySet<string>
}) {
  if (!onPage.has(block)) return <code className="block-link">{block}</code>
  return (
    <a
      href={`#${frameId(block)}`}
      className="block-link"
      onClick={(event) => {
        event.preventDefault()
        scrollToBlock(event.currentTarget.ownerDocument, block)
      }}
    >
      {block}
    </a>
  )
}

/** The class's default view. Form and credential blocks get theirs with their first blocks. */
function Body({ block, children }: { readonly block: Configured; readonly children: ReactNode }) {
  switch (block.class) {
    case "display":
    case "task":
      return <div className="block-body">{children}</div>
    case "form":
      return <NoView line="The window can't show this form's fields yet.">{children}</NoView>
    case "credential":
      return <NoView line="The window can't show this sign-in yet.">{children}</NoView>
    default: {
      const unhandled: never = block.class
      throw new Error(`The frame has no body for the class ${String(unhandled)}.`)
    }
  }
}

/** A block whose class has no default view yet: its markdown, and a line that says so. */
function NoView({ line, children }: { readonly line: string; readonly children: ReactNode }) {
  return (
    <div className="block-body">
      {children}
      <p className="block-no-view">{line}</p>
    </div>
  )
}
