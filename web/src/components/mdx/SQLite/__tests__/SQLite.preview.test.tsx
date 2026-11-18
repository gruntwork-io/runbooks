/**
 * Génère un aperçu HTML statique du composant <SQLite> dans plusieurs états,
 * pour validation visuelle sans lancer Electron. Le fichier généré est
 * web/src/components/mdx/SQLite/__tests__/sqlite-preview.html (gitignoré).
 *
 * Lancer avec: mise exec -- bun x vitest run SQLite.preview.test.tsx
 */
import { describe, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { TestWrapper } from "@/test/test-utils"
import SQLite from "../SQLite"
import type { SqlQueryResult } from "../types"

const invoke = vi.fn().mockResolvedValue(undefined)
const api = { invoke, on: vi.fn(() => () => {}) }

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => api }
})

vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

// On rend le composant et on attend que le run se termine, puis on dump le HTML.
// Comme on ne peut pas faire d'interaction réelle ici, on rend 3 blocs dans
// des états différents en mockant invoke différemment — mais le plus simple
// est de rendre le bloc "pending" (état initial) plus un bloc qu'on force
// en success via un mock qui se résout immédiatement.

const selectResult: SqlQueryResult = {
  columns: ["id", "name", "email"],
  rows: [
    [1, "Alice", "alice@example.com"],
    [2, "Bob", null],
    [3, "Charlie", "charlie@example.com"],
  ],
  rowCount: 3,
  isRead: true,
}

const emptyResult: SqlQueryResult = {
  columns: ["id", "name"],
  rows: [],
  rowCount: 0,
  isRead: true,
}

function renderToHtml(element: React.ReactElement): string {
  const { container } = render(<TestWrapper>{element}</TestWrapper>)
  return container.innerHTML
}

const tailwindCdn = `<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: system-ui, sans-serif; background: #fff; padding: 2rem; }
  /* Tailwind CDN needs these utility classes to exist; we inline the ones we use */
</style>`

describe("SQLite visual preview", () => {
  it("generates sqlite-preview.html", async () => {
    // État pending (initial)
    const pending = renderToHtml(
      <SQLite
        id="demo-pending"
        db="./demo.db"
        query="SELECT id, name, email FROM users ORDER BY id"
        title="List all users"
        description="Selects every row from the users table."
      />,
    )

    // État success — on simule en rendant puis en cliquant... mais pour un
    // aperçu statique, on rend un bloc et on injecte le résultat via le mock.
    // Solution plus simple : on rend le composant, on déclenche le run via
    // le bouton, on attend, puis on dump.
    const { container: successContainer, unmount: unmountSuccess } = render(
      <TestWrapper>
        <SQLite
          id="demo-success"
          db="./demo.db"
          query="SELECT id, name, email FROM users ORDER BY id"
          title="List all users"
          description="The result is exported as the `users` output."
          output="users"
        />
      </TestWrapper>,
    )

    invoke.mockResolvedValue(selectResult)
    const button = successContainer.querySelector("button")!
    button.click()
    // Attendre que React mette à jour le DOM
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
    const success = successContainer.innerHTML
    unmountSuccess()

    // État success avec résultat vide
    const { container: emptyContainer, unmount: unmountEmpty } = render(
      <TestWrapper>
        <SQLite
          id="demo-empty"
          db="./demo.db"
          query="SELECT id, name FROM users WHERE 1=0"
          title="Empty result"
          description="No rows match this query."
        />
      </TestWrapper>,
    )
    invoke.mockResolvedValue(emptyResult)
    emptyContainer.querySelector("button")!.click()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
    const empty = emptyContainer.innerHTML
    unmountEmpty()

    // État erreur
    const { container: failContainer, unmount: unmountFail } = render(
      <TestWrapper>
        <SQLite
          id="demo-fail"
          db="./demo.db"
          query="SELECT * FROM nonexistent_table"
          title="This query will fail"
          failMessage="Query failed as expected"
        />
      </TestWrapper>,
    )
    invoke.mockRejectedValue(new Error("no such table: nonexistent_table"))
    failContainer.querySelector("button")!.click()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
    const fail = failContainer.innerHTML
    unmountFail()

    // État write (INSERT)
    const { container: writeContainer, unmount: unmountWrite } = render(
      <TestWrapper>
        <SQLite
          id="demo-write"
          db="./demo.db"
          query="INSERT INTO users (name, email) VALUES (?, ?)"
          params={["Alice", "alice@example.com"]}
          title="Insert Alice"
        />
      </TestWrapper>,
    )
    invoke.mockResolvedValue({ columns: [], rows: [], rowCount: 1, isRead: false })
    writeContainer.querySelector("button")!.click()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
    const write = writeContainer.innerHTML
    unmountWrite()

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SQLite Block Preview</title>
${tailwindCdn}
</head>
<body>
<h1 class="text-2xl font-bold mb-6">SQLite Block — Visual Preview</h1>

<h2 class="text-lg font-semibold mt-8 mb-2">1. Pending (initial state)</h2>
${pending}

<h2 class="text-lg font-semibold mt-8 mb-2">2. Success — SELECT with rows</h2>
${success}

<h2 class="text-lg font-semibold mt-8 mb-2">3. Success — empty result</h2>
${empty}

<h2 class="text-lg font-semibold mt-8 mb-2">4. Success — write query (INSERT)</h2>
${write}

<h2 class="text-lg font-semibold mt-8 mb-2">5. Error state</h2>
${fail}
</body>
</html>`

    const outPath = join(__dirname, "sqlite-preview.html")
    writeFileSync(outPath, html)
    console.log(`Preview written to ${outPath}`)
  })
})
