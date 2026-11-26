/**
 * The rebuilt app's window: the React root, over one engine client per
 * page load (`engine.ts`), which lasts as long as the page.
 */
import { Effect, Scope } from "effect"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"
import { makeEngineClient } from "./engine.ts"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

const client = Effect.runSync(
  Effect.flatMap(Scope.make(), (scope) => Scope.provide(makeEngineClient(window.engine), scope)),
)

createRoot(root).render(
  <StrictMode>
    <App engine={client} />
  </StrictMode>,
)
