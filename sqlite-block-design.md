# SQLite Block — Design Document

> **Status: implemented.** Frontend (`web/src/components/mdx/SQLite/`),
> domain (`src/domain/sqlite/`), IPC (`electron/main/ipc/sqlite.ts`).
> Demo runbook: `testdata/sample-runbooks/sqlite-demo/`.

## Goal

Add a `<SQLite>` MDX block that executes SQL queries against a SQLite database
file (or `:memory:`), displays results as an interactive table in the
renderer (per-column sort + filter), and can export results as block outputs
for use by later blocks.

## Why SQLite is already available

The app already uses Node's built-in `node:sqlite` module (no native addon) for
its own session store:

- `src/layers/NodeSqlite.ts` — opens a `DatabaseSync` and adapts it to the
  `SqlDatabase` interface.
- `src/domain/session/store.ts` — defines `SqlDatabase` / `SqlStatement`
  interfaces so domain modules never import `node:sqlite` directly.

The new block reuses this exact pattern: domain code speaks `SqlDatabase`,
the layer opens it.

## Architecture

```
web/src/components/mdx/SQLite/
├── SQLite.tsx              ← React component (table UI + Run button)
├── index.ts
└── __tests__/
    └── SQLite.test.tsx

src/domain/sqlite/
├── query.ts                ← runQuery(db, sql, params) Effect
├── query.test.ts
├── result.ts               ← SqlQueryResult type (columns, rows, rowCount)
└── result.test.ts

electron/main/ipc/sqlite.ts ← IPC handlers (sqlite:query, sqlite:tables, sqlite:schema)
electron/shared/channels.ts ← "sqlite:*" channel contracts
electron/preload/index.ts   ← expose channels to renderer
electron/main/ipc/index.ts  ← registerSqliteHandlers()
web/src/components/MDXContainer.tsx ← add SQLite to MDX_COMPONENTS
docs/src/content/docs/authoring/blocks/SQLite.mdx
testdata/sample-runbooks/sqlite-demo/
```

## IPC Channels

| Channel | Params | Result |
|---|---|---|
| `sqlite:query` | `{ dbPath: string, sql: string, params?: SqlParam[] }` | `SqlQueryResult` |
| `sqlite:tables` | `{ dbPath: string }` | `{ tables: string[] }` |

(`sqlite:schema` was dropped — the interactive table doesn't need it yet.)

## Block Props (MDX)

```mdx
<SQLite
  id="create-users"
  db="./ma-base.db"
  query="CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
/>

<SQLite
  id="insert-user"
  db="./ma-base.db"
  query="INSERT INTO users (name) VALUES (?)"
  params={["Alice"]}
/>

<SQLite
  id="list-users"
  db="./ma-base.db"
  query="SELECT * FROM users ORDER BY id"
  output="users"
/>
```

| Prop | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique block id |
| `db` | string | yes | Path to the `.db` file (relative to worktree) or `:memory:` |
| `query` | string | yes | SQL statement; `?` placeholders for params |
| `params` | array | no | Values bound to `?` placeholders (never string-concatenated) |
| `output` | string | no | Name of the output variable holding the result rows |

## Execution Flow

```
Renderer (SQLite.tsx)
  → api.invoke("sqlite:query", { dbPath, sql, params })
    → Main (ipc/sqlite.ts) → runtime.runPromise(...)
      → validateSessionPath(dbPath)   ← path-guard, :memory: allowed
      → openSqliteDatabase(dbPath)    ← src/layers/NodeSqlite.ts
      → runQuery(db, sql, params)     ← src/domain/sqlite/query.ts
        → stmt.columns() > 0 ? all() : run()
        → return { columns, rows, rowCount, isRead }
  → ResultTable (sort ASC→DESC→none per column, per-column filters)
  → registerOutputs if `output` prop set
```

## Safety Rules

1. **No `node:sqlite` import in `src/domain/`** — domain speaks `SqlDatabase`,
   `src/layers/NodeSqlite.ts` opens it.
2. **Path validation** — `dbPath` resolved through `path-guard.ts`, must be
   inside the session worktree (except `:memory:`).
3. **Parameterized queries only** — `?` placeholders, never SQL string
   concatenation. This is enforced by the API shape (separate `params` array).
4. **Typed errors** — `SqliteQueryError` added to `src/errors/index.ts`.
5. **Read-only vs write** — `SELECT`/`PRAGMA` return rows; `INSERT`/`UPDATE`/
   `CREATE` return rowCount. The block auto-detects via result shape.

## Types

```ts
// src/domain/sqlite/result.ts
interface SqlQueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number       // affected rows for writes, rows.length for reads
  isRead: boolean        // true when the query returned a result set
}

interface ColumnInfo {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
}
```

## Testing Strategy

1. **Unit (domain)** — `src/domain/sqlite/query.test.ts`: run queries against
   `:memory:` db, verify results, error cases.
2. **Unit (component)** — `web/src/components/mdx/SQLite/__tests__/SQLite.test.tsx`:
   render with mocked `useApi()`, verify table display, run button, error states.
3. **Runbook integration** — `testdata/sample-runbooks/sqlite-demo/` with
   `runbook_test.yml`.

## Open Questions

- Should the block support multiple statements in one `query` prop?
  (Proposed: no, one statement per block — clearer outputs and errors.)
- Should `db` support absolute paths outside the worktree?
  (Proposed: no, same security model as generated files.)
