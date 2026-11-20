import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { RunbookContext } from "@/contexts/RunbookContext"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import SQLite from "../SQLite"
import type { SqlQueryResult } from "../types"
import { sensitiveOutput } from "@/lib/outputValues"

// ---------------------------------------------------------------------------
// Mock the IPC boundary — the api.invoke("sqlite:query") call. The real
// backend handler lives in electron/main/ipc/sqlite.ts; these tests validate
// the UI shape with controlled mock responses.
// ---------------------------------------------------------------------------

const invoke = vi.fn().mockResolvedValue(undefined)
const api = { invoke, on: vi.fn(() => () => {}) }

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => api }
})

// Mock useLogs since it may be used indirectly by shared components
vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSQLite(props: Partial<React.ComponentProps<typeof SQLite>> = {}) {
  return render(
    <TestWrapper>
      <SQLite id="test-sqlite" db="./test.db" query="SELECT 1" {...props} />
    </TestWrapper>,
  )
}

const selectResult: SqlQueryResult = {
  columns: ["id", "name"],
  rows: [
    [1, "Alice"],
    [2, "Bob"],
  ],
  rowCount: 2,
  isRead: true,
}

const writeResult: SqlQueryResult = {
  columns: [],
  rows: [],
  rowCount: 1,
  isRead: false,
}

// Minimal context with inputs { Name: "Alice" } visible via inputsId —
// declared at module level so the Provider value is a stable reference.
const templateCtxValue = {
  getTemplateContext: () => ({ inputs: { Name: "Alice" }, outputs: {} }),
  registerOutputs: vi.fn(),
} as unknown as RunbookContextType

// A context whose outputs include a sensitive one, to check that execution
// gets the real value while the display stays masked.
const templateCtxWithSecret = {
  getTemplateContext: () => ({
    inputs: {},
    outputs: { auth: { token: sensitiveOutput("s3cret") } },
  }),
  registerOutputs: vi.fn(),
} as unknown as RunbookContextType

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SQLite block", () => {
  it("renders the block with db path and query preview", () => {
    renderSQLite({ query: "SELECT * FROM users" })
    expect(screen.getByTestId("sqlite-block")).toBeDefined()
    expect(screen.getByText("./test.db")).toBeDefined()
    expect(screen.getByText("SELECT * FROM users")).toBeDefined()
  })

  it("shows a config error when db is missing", () => {
    renderSQLite({ db: "" })
    expect(screen.getByTestId("component-error")).toBeDefined()
    expect(screen.getByText(/requires a 'db' prop/)).toBeDefined()
  })

  it("shows a config error when neither query nor path is given", () => {
    renderSQLite({ query: "" })
    expect(screen.getByTestId("component-error")).toBeDefined()
    expect(screen.getByText(/requires a 'query' or 'path' prop/)).toBeDefined()
  })

  it("shows a config error when both query and path are given", () => {
    renderSQLite({ query: "SELECT 1", path: "./seed.sql" })
    expect(screen.getByTestId("component-error")).toBeDefined()
    expect(screen.getByText(/not both/)).toBeDefined()
  })

  it("resolves template references inside params before sending", async () => {
    invoke.mockResolvedValue(writeResult)
    const user = userEvent.setup()
    render(
      <TestWrapper>
        <RunbookContext.Provider value={templateCtxValue}>
          <SQLite
            id="tpl-params"
            db="./test.db"
            query="INSERT INTO users (name) VALUES (?)"
            params={["{{ .inputs.Name }}"]}
            inputsId="user-form"
          />
        </RunbookContext.Provider>
      </TestWrapper>,
    )

    await user.click(screen.getByRole("button", { name: /run/i }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "sqlite:query",
        expect.objectContaining({ params: ["Alice"] }),
      )
    })
  })

  it("sends sensitive outputs revealed over IPC but shows them masked", async () => {
    invoke.mockResolvedValue(writeResult)
    const user = userEvent.setup()
    render(
      <TestWrapper>
        <RunbookContext.Provider value={templateCtxWithSecret}>
          <SQLite
            id="secret-query"
            db="./test.db"
            query="INSERT INTO tokens (value) VALUES (?) -- {{ .outputs.auth.token }}"
            params={["{{ .outputs.auth.token }}"]}
          />
        </RunbookContext.Provider>
      </TestWrapper>,
    )

    // Display preview masks the sensitive output
    expect(screen.getByText(/<redacted>/)).toBeDefined()

    await user.click(screen.getByRole("button", { name: /run/i }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "sqlite:query",
        expect.objectContaining({
          params: ["s3cret"],
          sql: "INSERT INTO tokens (value) VALUES (?) -- s3cret",
        }),
      )
    })
  })

  it("runs a SQL file via the path prop", async () => {
    invoke.mockResolvedValue({ columns: [], rows: [], rowCount: 0, isRead: false })
    const user = userEvent.setup()
    renderSQLite({ query: "", path: "./seed.sql" })

    expect(screen.getByText("SQL file: ./seed.sql")).toBeDefined()
    await user.click(screen.getByRole("button", { name: /run/i }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "sqlite:query",
        expect.objectContaining({ dbPath: "./test.db", sqlPath: "./seed.sql" }),
      )
    })
    // No sql key sent when using path
    const call = invoke.mock.calls.find((c) => c[0] === "sqlite:query")
    expect(call?.[1]).not.toHaveProperty("sql")
  })

  it("runs the query and displays a result table for SELECT", async () => {
    invoke.mockResolvedValue(selectResult)
    const user = userEvent.setup()
    renderSQLite({ query: "SELECT id, name FROM users" })

    await user.click(screen.getByRole("button", { name: /run/i }))

    await waitFor(() => {
      expect(screen.getByText("id")).toBeDefined()
      expect(screen.getByText("name")).toBeDefined()
      expect(screen.getByText("Alice")).toBeDefined()
      expect(screen.getByText("Bob")).toBeDefined()
    })
    expect(invoke).toHaveBeenCalledWith("sqlite:query", {
      dbPath: "./test.db",
      sql: "SELECT id, name FROM users",
      params: [],
    })
  })

  it("shows affected row count for write queries", async () => {
    invoke.mockResolvedValue(writeResult)
    const user = userEvent.setup()
    renderSQLite({ query: "INSERT INTO users (name) VALUES (?)", params: ["Alice"] })

    await user.click(screen.getByRole("button", { name: /run/i }))

    await waitFor(() => {
      expect(screen.getByText("1 row affected")).toBeDefined()
    })
    expect(invoke).toHaveBeenCalledWith("sqlite:query", {
      dbPath: "./test.db",
      sql: "INSERT INTO users (name) VALUES (?)",
      params: ["Alice"],
    })
  })

  it("shows 'No rows returned' for an empty SELECT result", async () => {
    invoke.mockResolvedValue({ columns: ["id"], rows: [], rowCount: 0, isRead: true })
    const user = userEvent.setup()
    renderSQLite({ query: "SELECT id FROM users WHERE 1=0" })

    await user.click(screen.getByRole("button", { name: /run/i }))

    await waitFor(() => {
      expect(screen.getByText("No rows returned")).toBeDefined()
    })
  })

  it("displays an error when the query fails", async () => {
    invoke.mockRejectedValue(new Error("no such table: users"))
    const user = userEvent.setup()
    renderSQLite({ query: "SELECT * FROM users" })

    await user.click(screen.getByRole("button", { name: /run/i }))

    await waitFor(() => {
      expect(screen.getByText(/no such table: users/)).toBeDefined()
    })
  })

  it("shows NULL for null cell values", async () => {
    invoke.mockResolvedValue({
      columns: ["id", "nickname"],
      rows: [[1, null]],
      rowCount: 1,
      isRead: true,
    })
    const user = userEvent.setup()
    renderSQLite()

    await user.click(screen.getByRole("button", { name: /run/i }))

    await waitFor(() => {
      expect(screen.getByText("NULL")).toBeDefined()
    })
  })

  it("renders optional title and description", () => {
    renderSQLite({ title: "List all users", description: "Shows every row in the users table" })
    expect(screen.getByText("List all users")).toBeDefined()
    expect(screen.getByText("Shows every row in the users table")).toBeDefined()
  })

  // -----------------------------------------------------------------------
  // Interactive table: sort + filter
  // -----------------------------------------------------------------------

  const multiRowResult: SqlQueryResult = {
    columns: ["id", "name"],
    rows: [
      [3, "Charlie"],
      [1, "Alice"],
      [2, "Bob"],
    ],
    rowCount: 3,
    isRead: true,
  }

  async function runAndGetTable(result: SqlQueryResult) {
    invoke.mockResolvedValue(result)
    const user = userEvent.setup()
    renderSQLite({ query: "SELECT id, name FROM users" })
    await user.click(screen.getByRole("button", { name: /run/i }))
    await waitFor(() => {
      expect(screen.getByText("Charlie")).toBeDefined()
    })
    return user
  }

  /** Body rows only (skip header + optional filter row). */
  function bodyRows() {
    return screen.getAllByRole("row").filter((r) => !r.querySelector("th"))
  }

  /** Footer text (React splits it across text nodes, so read textContent). */
  function footerText() {
    return screen.getByTestId("result-footer").textContent
  }

  it("sorts ASC → DESC → none when clicking a column name repeatedly", async () => {
    const user = await runAndGetTable(multiRowResult)
    // Initial order: Charlie(3), Alice(1), Bob(2)
    const nameHeader = screen.getByRole("button", { name: /^name$/i })

    // 1st click: ASC by name → Alice, Bob, Charlie
    await user.click(nameHeader)
    let cells = bodyRows()
    expect(cells[0]!.textContent).toContain("Alice")
    expect(cells[2]!.textContent).toContain("Charlie")

    // 2nd click: DESC → Charlie, Bob, Alice
    await user.click(nameHeader)
    cells = bodyRows()
    expect(cells[0]!.textContent).toContain("Charlie")
    expect(cells[2]!.textContent).toContain("Alice")

    // 3rd click: sort cleared → back to original order
    await user.click(nameHeader)
    cells = bodyRows()
    expect(cells[0]!.textContent).toContain("Charlie")
    expect(cells[2]!.textContent).toContain("Bob")
  })

  it("sorts numerically by id column", async () => {
    const user = await runAndGetTable(multiRowResult)

    const idHeader = screen.getByRole("button", { name: /^id$/i })
    await user.click(idHeader) // ASC: 1, 2, 3
    const cells = bodyRows()
    expect(cells[0]!.textContent).toContain("Alice")
    expect(cells[2]!.textContent).toContain("Charlie")
  })

  it("filters rows by per-column filter input", async () => {
    const user = await runAndGetTable(multiRowResult)

    // Open the filter for the "name" column
    await user.click(screen.getByRole("button", { name: "Filter name" }))
    const filterInput = await screen.findByPlaceholderText("Filter name...")
    await user.type(filterInput, "ali")

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeDefined()
      expect(screen.queryByText("Bob")).toBeNull()
      expect(screen.queryByText("Charlie")).toBeNull()
    })
    expect(footerText()).toContain("1 of 3 rows")
    expect(footerText()).toContain("1 filter active")
  })

  it("combines filters across multiple columns (AND)", async () => {
    const user = await runAndGetTable(multiRowResult)

    // Filter name contains "b" → Bob
    await user.click(screen.getByRole("button", { name: "Filter name" }))
    await user.type(await screen.findByPlaceholderText("Filter name..."), "b")
    // Open filter for id column and type "2" → only id=2 AND name~b → Bob
    await user.click(screen.getByRole("button", { name: "Filter id" }))
    await user.type(await screen.findByPlaceholderText("Filter id..."), "2")

    await waitFor(() => {
      expect(screen.getByText("Bob")).toBeDefined()
      expect(screen.queryByText("Alice")).toBeNull()
      expect(screen.queryByText("Charlie")).toBeNull()
    })
    expect(footerText()).toContain("1 of 3 rows")
    expect(footerText()).toContain("2 filters active")
  })

  it("shows 'No rows match the filters' when filters match nothing", async () => {
    const user = await runAndGetTable(multiRowResult)

    await user.click(screen.getByRole("button", { name: "Filter name" }))
    await user.type(await screen.findByPlaceholderText("Filter name..."), "zzz")

    await waitFor(() => {
      expect(screen.getByText("No rows match the filters")).toBeDefined()
    })
  })

  it("clears a column filter via its clear button", async () => {
    const user = await runAndGetTable(multiRowResult)

    await user.click(screen.getByRole("button", { name: "Filter name" }))
    await user.type(await screen.findByPlaceholderText("Filter name..."), "ali")
    await waitFor(() => {
      expect(screen.queryByText("Bob")).toBeNull()
    })

    await user.click(screen.getByRole("button", { name: "Clear name filter" }))
    await waitFor(() => {
      expect(screen.getByText("Bob")).toBeDefined()
      expect(screen.getByText("Charlie")).toBeDefined()
    })
  })
})
