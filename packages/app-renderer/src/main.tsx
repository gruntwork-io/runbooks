/**
 * The rebuilt app's window: the React root. Until it walks a runbook (row
 * 3g), it shows what only the engine knows, over its client: the settings
 * file, which `GetSettings` names, and the theme, as `WatchSettings` reports
 * it after each change.
 */
import { Effect, Scope, Stream } from "effect"
import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { EngineClient } from "@runbooks/core/protocol"
import { makeEngineClient } from "./engine.ts"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

// One client per page load, which lasts as long as the page.
const client = Effect.runSync(
  Effect.flatMap(Scope.make(), (scope) => Scope.provide(makeEngineClient(window.engine), scope)),
)

/** The settings file, as the engine names it. */
function SettingsFile({ engine }: { readonly engine: EngineClient }) {
  const [shown, setShown] = useState("Asking the engine.")
  useEffect(() => {
    const fiber = Effect.runFork(
      engine.GetSettings().pipe(
        Effect.match({
          onSuccess: (view) => `Settings file: ${view.file}`,
          onFailure: (error) => `The engine did not answer: ${error.message}`,
        }),
        Effect.flatMap((text) => Effect.sync(() => setShown(text))),
      ),
    )
    return () => fiber.interruptUnsafe()
  }, [engine])
  return <p>{shown}</p>
}

/** The theme setting, kept up to date by the engine's stream. */
function Theme({ engine }: { readonly engine: EngineClient }) {
  const [shown, setShown] = useState("Watching the settings.")
  useEffect(() => {
    const fiber = Effect.runFork(
      engine.WatchSettings().pipe(
        Stream.runForEach((view) => Effect.sync(() => setShown(`Theme: ${view.settings.theme}`))),
        Effect.catch((error) =>
          Effect.sync(() => setShown(`The engine stopped: ${error.message}`)),
        ),
      ),
    )
    return () => fiber.interruptUnsafe()
  }, [engine])
  return <p>{shown}</p>
}

createRoot(root).render(
  <StrictMode>
    <h1>Runbooks</h1>
    <SettingsFile engine={client} />
    <Theme engine={client} />
  </StrictMode>,
)
