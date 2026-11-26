/**
 * The rebuilt app's window: the React root. It shows the app's name until
 * the window has an engine client and a document to walk.
 */
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <h1>Runbooks</h1>
  </StrictMode>,
)
