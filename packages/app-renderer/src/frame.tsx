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
 * - the body: the block's own view, when the view map has a line for it
 *   (`@runbooks/blocks/views`), or its class's default. A task's default
 *   offers the actions the engine says it takes now (`BlockView.actions`)
 *   and shows its latest run's log and outputs, as text; a form's and a
 *   credential block's defaults are not written yet, and a display block
 *   always has a view.
 *
 * A view asks the engine through `act`, which the frame sends for its
 * session and block, and it shows what the engine answered.
 *
 * In instruction mode (`Settings.instructionMode`) a task or credential
 * block shows its instruction (`BlockView.instruction`) in place of its view
 * and its status: each text step as text, each command to select and copy,
 * each link as a link the walk would make. The frame then sends nothing a
 * view asks for but a form's values (`SetValues`), whatever its class. A
 * form still shows its view: it is how the person gives the values an
 * instruction reads.
 *
 * Classes, statuses, blockers and errors are closed sets: each switch over
 * one names every member, so a new one fails the build here.
 */
import { Effect, type Schema } from "effect"
import { createContext, Fragment, type ReactNode, useContext, useState } from "react"
import { type View, type ViewRequest, views } from "@runbooks/blocks/views"
import type {
  BlockAction,
  BlockView,
  DocumentBlock,
  Instruction,
  LogPage,
  OutputView,
} from "@runbooks/core/protocol"
import { BlockLink, frameId } from "./blockLink.tsx"
import { FollowingContext, useBlockView, useInstructionMode } from "./following.ts"
import { linkTarget } from "./markdown.tsx"
import { place } from "./place.ts"

type Configured = Extract<DocumentBlock, { readonly _tag: "Configured" }>
type BlockStatus = NonNullable<BlockView["status"]>
type Blocker = Extract<BlockStatus, { readonly _tag: "Blocked" }>["by"][number]
type Capability = Extract<Blocker, { readonly _tag: "WaitingFor" }>["capability"]
type Failure = Extract<BlockStatus, { readonly _tag: "Failed" }>["error"]

/**
 * The view map, by registry block. A view draws from the props the
 * document sends (`DocumentBlock.props`), as JSON. Tests give their own.
 */
export const ViewsContext =
  createContext<Readonly<Partial<Record<string, View<Schema.Json>>>>>(views)

/** Whether instruction mode shows a block of `kind` as its instruction. */
function instructedIn(kind: DocumentBlock["class"]): boolean {
  switch (kind) {
    case "task":
    case "credential":
      return true
    case "form":
    case "display":
      return false
    default: {
      const unhandled: never = kind
      throw new Error(`The frame has no instruction mode for the class ${String(unhandled)}.`)
    }
  }
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

/**
 * Whether instruction mode sends `request`. It runs nothing, so only a
 * form's values go through: an instruction reads them.
 */
function takenInInstructionMode(request: ViewRequest): boolean {
  switch (request._tag) {
    case "SetValues":
      return true
    case "RunBlock":
    case "CancelBlock":
    case "ResetBlock":
    case "ActOnCredential":
      return false
    default: {
      const unhandled: never = request
      return unhandled
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
  const view = useBlockView(block.id)
  const status = view?.status
  const following = useContext(FollowingContext)
  const instructionMode = useInstructionMode()
  const instructed = instructionMode && instructedIn(block.class)
  const [said, setSaid] = useState<string>()
  const act = (request: ViewRequest) => {
    if (block.id === undefined || (instructionMode && !takenInInstructionMode(request))) return
    Effect.runFork(
      Effect.flatMap(following.act(block.id, request), (line) => Effect.sync(() => setSaid(line))),
    )
  }
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
              {status === undefined || instructed ? null : (
                <Status status={status} onPage={onPage} />
              )}
              {said === undefined ? null : <p className="block-said">{said}</p>}
              {instructed ? (
                <InstructionBody instruction={view?.instruction}>{children}</InstructionBody>
              ) : (
                <Body block={block} view={view} act={act}>
                  {children}
                </Body>
              )}
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
    // A TaskFailed message says its exit code, when it has one.
    case "TaskFailed":
    case "PathOutsideRoot":
    case "CredentialError":
      return `Failed: ${error.message}`
    case "TaskCancelled":
      return "Cancelled"
    case "TaskTimedOut":
      return `Timed out after ${Math.round(error.afterMillis / 1000)} seconds`
    case "PropError":
      return `Failed: \`${error.prop}\` ${error.message}`
    case "TaskBlocked":
      return `Failed: it was blocked by ${error.by.join(", ")}`
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

/** Which of two blocks that may not run at once runs alone, before "runs alone". */
function alone(runsAlone: Extract<Blocker, { readonly _tag: "Exclusive" }>["runsAlone"]): string {
  switch (runsAlone) {
    case "running":
      return "it"
    case "waiting":
      return "this block"
    default: {
      const unhandled: never = runsAlone
      throw new Error(`The frame has no words for ${String(unhandled)} running alone.`)
    }
  }
}

/** A block a blocked block waits for, and what it waits for that block to do. */
interface Waiting {
  readonly key: string
  readonly block: string
  readonly reason: ReactNode
}

/** What a blocked block waits for: trust, and each block it waits for, as a link to it. */
function Blockers({
  by,
  onPage,
}: {
  readonly by: ReadonlyArray<Blocker>
  readonly onPage: ReadonlySet<string>
}) {
  let untrusted = false
  const waiting: Waiting[] = []
  for (const blocker of by)
    switch (blocker._tag) {
      case "Untrusted":
        untrusted = true
        break
      case "WaitingFor": {
        const { block, capability } = blocker
        waiting.push({ key: `${block} ${capability}`, block, reason: need(capability) })
        break
      }
      case "EmptyInput": {
        const { block, input } = blocker
        waiting.push({
          key: `${block} input ${input}`,
          block,
          reason: (
            <>
              to have a value for <code>{input}</code>
            </>
          ),
        })
        break
      }
      case "Exclusive": {
        const { block, runsAlone } = blocker
        waiting.push({
          key: `${block} running`,
          block,
          reason: `to finish: ${alone(runsAlone)} runs alone`,
        })
        break
      }
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
            {waiting.map(({ key, block, reason }) => (
              <li key={key}>
                <BlockLink block={block} onPage={onPage} /> {reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** The block's own view, or its class's default. Form and credential blocks get theirs with their first blocks. */
function Body({
  block,
  view,
  act,
  children,
}: {
  readonly block: Configured
  readonly view: BlockView | undefined
  readonly act: (request: ViewRequest) => void
  readonly children: ReactNode
}) {
  const Own = useContext(ViewsContext)[block.block]
  if (Own !== undefined && block.props !== undefined)
    return (
      <div className="block-body">
        <Own props={block.props} status={view?.status} act={act}>
          {children}
        </Own>
      </div>
    )
  switch (block.class) {
    case "task":
      return (
        <div className="block-body">
          {children}
          <TaskView view={view} act={act} />
        </div>
      )
    // views.ts requires a view for every display block: this is one the document sent no props for.
    case "display":
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

interface Button {
  readonly label: string
  readonly request: ViewRequest
}

/** The buttons a task's default view offers for `actions`, and what each asks the engine. */
export function buttonsFor(actions: ReadonlyArray<BlockAction>): ReadonlyArray<Button> {
  return actions.flatMap((action): ReadonlyArray<Button> => {
    switch (action) {
      case "run":
        return [{ label: "Run", request: { _tag: "RunBlock" } }]
      case "cancel":
        return [{ label: "Cancel", request: { _tag: "CancelBlock" } }]
      case "reset":
        return [{ label: "Reset", request: { _tag: "ResetBlock" } }]
      // A task's own form (row 3k), an agent's review, and a credential block's actions.
      case "setValues":
      case "confirmValues":
      case "credential":
        return []
      default: {
        const unhandled: never = action
        throw new Error(`The task view has no button for ${String(unhandled)}.`)
      }
    }
  })
}

/** A task's default view: the actions it takes now, and its latest run's log and outputs. */
function TaskView({
  view,
  act,
}: {
  readonly view: BlockView | undefined
  readonly act: (request: ViewRequest) => void
}) {
  const buttons = buttonsFor(view?.actions ?? [])
  return (
    <>
      {buttons.length === 0 ? null : (
        <div className="block-actions">
          {buttons.map(({ label, request }) => (
            <button key={label} type="button" onClick={() => act(request)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {view?.log === undefined ? null : <Log page={view.log} />}
      {view === undefined ? null : <Outputs outputs={view.outputs} />}
    </>
  )
}

/** The outputs a task's latest run gave, by name: each value as text, or that it is hidden. */
function Outputs({ outputs }: { readonly outputs: BlockView["outputs"] }) {
  const named = Object.entries(outputs)
  if (named.length === 0) return null
  return (
    <dl className="block-outputs" aria-label="Outputs">
      {named.map(([name, output]) => (
        <Fragment key={name}>
          <dt>{name}</dt>
          <OutputValue output={output} />
        </Fragment>
      ))}
    </dl>
  )
}

function OutputValue({ output }: { readonly output: OutputView }) {
  switch (output._tag) {
    case "Shown":
      return <dd>{output.value}</dd>
    case "Hidden":
      return <dd className="block-output-hidden">Hidden: it is sensitive.</dd>
    default: {
      const unhandled: never = output
      throw new Error(`The frame has no words for the output ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** One page of a run's log, which says which lines it holds when they are not all of them. */
function Log({ page }: { readonly page: LogPage }) {
  const whole = page.offset === 0 && page.lines.length === page.total
  return (
    <>
      {whole ? null : (
        <p className="block-log-part">
          {`Lines ${page.offset + 1} to ${page.offset + page.lines.length} of ${page.total}.`}
        </p>
      )}
      <pre className="block-log" aria-label="Log">
        {page.lines.map((line, index) => (
          <span key={page.offset + index} className={`log-${line.stream}`}>
            {`${line.text}\n`}
          </span>
        ))}
      </pre>
    </>
  )
}

/** A block in instruction mode: its markdown, then its instruction, once the engine sent it. */
function InstructionBody({
  instruction,
  children,
}: {
  readonly instruction: Instruction | undefined
  readonly children: ReactNode
}) {
  return (
    <div className="block-body">
      {children}
      {instruction === undefined ? null : (
        <div className="block-instruction">
          {instruction.map((step, index) => (
            <InstructionStep key={index} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}

function InstructionStep({ step }: { readonly step: Instruction[number] }) {
  switch (step.kind) {
    case "text":
      return <p>{step.markdown}</p>
    case "code":
      // One click selects the whole command, to copy with the keyboard (app.css).
      return (
        <pre className="block-command">
          <code className={`language-${step.language}`}>{step.code}</code>
        </pre>
      )
    case "link": {
      const target = linkTarget(step.url)
      return target === undefined ? (
        <p>{`${step.label} (${step.url})`}</p>
      ) : (
        <p>
          <a href={target}>{step.label}</a>
        </p>
      )
    }
    default: {
      const unhandled: never = step
      throw new Error(`The frame has no view of the step ${JSON.stringify(unhandled)}.`)
    }
  }
}
