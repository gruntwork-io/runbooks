/**
 * The window: the app's header, and the runbook of the session the engine
 * opened last, or a welcome screen when none is open. Main opens a runbook
 * the command line names before it answers the page
 * (packages/app-main/src/launch.ts), so `ListSessions` finds it. A later
 * launch's runbook opens while the page is up, and main then reloads it.
 */
import { Cause, Effect } from "effect"
import { useEffect, useState } from "react"
import type { DocumentView, EngineClient, SessionSummary, Settings } from "@runbooks/core/protocol"
import { FollowingContext, followingOf } from "./following.ts"
import { clientErrorText, defectText } from "./defect.ts"
import { Runbook } from "./runbook.tsx"
import { Welcome } from "./welcome.tsx"

type Shown =
  | { readonly _tag: "Asking" }
  | { readonly _tag: "Welcome" }
  | {
      readonly _tag: "Runbook"
      readonly session: SessionSummary
      readonly document: DocumentView
      readonly settings: Settings
    }
  | { readonly _tag: "Failed"; readonly message: string }

/** What a defect the engine sent says, as its message when it has one. */
/**
 * What the engine has open, as the window shows it: the session it opened
 * last, which `ListSessions` lists last. When the engine fails instead of
 * answering, as a runbook nested deep enough to overflow its stack makes
 * it, the window says so rather than asking forever.
 */
export const ask = (engine: EngineClient): Effect.Effect<Shown> =>
  Effect.gen(function* () {
    const session = (yield* engine.ListSessions()).at(-1)
    if (session === undefined) return { _tag: "Welcome" } as const
    const document = yield* engine.GetDocument({ session: session.session })
    const { settings } = yield* engine.GetSettings()
    return { _tag: "Runbook", session, document, settings } as const
  }).pipe(
    Effect.catchTags({
      RpcClientError: (error) =>
        Effect.succeed<Shown>({
          _tag: "Failed",
          message: `The engine did not answer: ${clientErrorText(error)}`,
        }),
      UnknownSession: () =>
        Effect.succeed<Shown>({
          _tag: "Failed",
          message: "The runbook's session closed before the window could show it.",
        }),
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed<Shown>({
            _tag: "Failed",
            message: `The engine failed showing the runbook: ${defectText(cause)}`,
          }),
    ),
  )

export function App({ engine }: { readonly engine: EngineClient }) {
  const [shown, setShown] = useState<Shown>({ _tag: "Asking" })
  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.flatMap(ask(engine), (next) => Effect.sync(() => setShown(next))),
    )
    return () => fiber.interruptUnsafe()
  }, [engine])
  return (
    <div className="app">
      <header className="app-header">Runbooks</header>
      <main className="app-main">
        <Content engine={engine} shown={shown} />
      </main>
    </div>
  )
}

function Content({ engine, shown }: { readonly engine: EngineClient; readonly shown: Shown }) {
  switch (shown._tag) {
    case "Asking":
      return <p className="asking">Asking the engine.</p>
    case "Welcome":
      return <Welcome />
    case "Runbook":
      return (
        <Followed
          key={shown.session.session}
          engine={engine}
          session={shown.session}
          document={shown.document}
          settings={shown.settings}
        />
      )
    case "Failed":
      return <p className="failed">{shown.message}</p>
    default: {
      const unhandled: never = shown
      throw new Error(`The window has no view for ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** The runbook, each block in it as the engine has it now. */
function Followed({
  engine,
  session,
  document,
  settings,
}: {
  readonly engine: EngineClient
  readonly session: SessionSummary
  readonly document: DocumentView
  /** As the window read them when it opened the runbook. */
  readonly settings: Settings
}) {
  const [following] = useState(() => followingOf(engine, session.session, settings))
  useEffect(() => following.start(), [following])
  return (
    <FollowingContext value={following}>
      <Runbook session={session} document={document} />
    </FollowingContext>
  )
}
