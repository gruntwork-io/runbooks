# Shared-Types Organization Refactor

## Problem

`WarmRenderDispatcher.ts` imports a string-union type (`WasmPerFileErrorKind`)
from `WasmRuntime.ts` purely for type composition. The two services are sibling
modules under `src/services/` and neither is the natural "owner" of the kind
union — it's a shared vocabulary describing per-file render outcomes that both
modules and their consumers reason about.

The repo already has a canonical home for shared cross-service types:
`src/errors/index.ts`. That file owns `WasmError`, `RenderError`, and a dozen
other tagged-error classes that services import without coupling to each
other's implementations.

The current state introduces a small but real architectural smell:

- `src/services/WarmRenderDispatcher.ts:12` imports from a peer service
- The string union `WarmDisabledReason` lives in `WarmRenderDispatcher.ts`
  but is also referenced by `electron/main/ipc/boilerplate.ts:334` (now
  type-checked via the `satisfies WarmRenderResult` annotation, but the
  literal still lives in IPC code)

## Goal

Move shared per-file/per-render type vocabulary into `src/errors/index.ts`
so:

1. Services depend on a shared module rather than on each other.
2. Consumers (IPC handlers, layers, dispatcher) import all render-outcome
   vocabulary from one place.
3. Adding a new kind requires one edit, not coordinated edits across
   `WasmRuntime.ts`, `WarmRenderDispatcher.ts`, and `ROUTE_TO_COLD_KINDS`.

## Scope (in)

- `WasmPerFileErrorKind` — string union of five per-file outcomes.
- `WarmDisabledReason` — string union of three "why warm was skipped"
  reasons.
- `ROUTE_TO_COLD_KINDS` — `Set<WasmPerFileErrorKind>` partitioning the
  cold-fallback subset. This is a const value, but it's tightly coupled to
  the union and belongs alongside it.

## Scope (out)

- Tagged error *classes* (`WasmError`, `RenderError`, etc.) stay where they
  are. They're already in `errors/index.ts`.
- `WarmFile`, `WarmPerFileError`, `WarmRenderResult`, `WasmRenderResult`,
  `InputsMapResult` — these are *service-shaped* types (describe a service's
  return value) and should stay with their owning service. Only the
  primitive vocabulary moves.
- `InputsMapResult.errors[].kind: string` — pass-through from the WASM
  boundary, no consumer code dispatches on it. Don't tighten; leave as-is.

## Migration steps

### Step 1: Move the unions and the set

Add to `src/errors/index.ts` (a new section near the bottom; keep tagged
errors grouped together at the top):

```ts
// ---------------------------------------------------------------------------
// Render vocabulary — shared between WasmRuntime, WarmRenderDispatcher, and
// the IPC handlers that orchestrate them.
// ---------------------------------------------------------------------------

/**
 * Per-file outcome when the WASM bridge processes one output path.
 * - `output_not_produced`, `dependency_not_in_bundle`, `dynamic_filename`
 *   route to the cold-render fallback (see ROUTE_TO_COLD_KINDS).
 * - `skip_files_excluded` means the file is deliberately omitted.
 * - `render` is a template bug worth surfacing to the user.
 */
export type WasmPerFileErrorKind =
  | "output_not_produced"
  | "dependency_not_in_bundle"
  | "dynamic_filename"
  | "skip_files_excluded"
  | "render"

/** Reason the warm path was disabled for a render. Debug-logging only. */
export type WarmDisabledReason =
  | "wasm-not-ready"
  | "no-output-paths-from-analyzer"
  | "warm-error-fallback"

/**
 * Per-file kinds that mean "WASM can't render this file but the subprocess
 * can." The dispatcher partitions on this set.
 *
 * `render` is deliberately NOT included: it indicates a template-execution
 * error that the cold subprocess would hit the same way (template-author
 * bug). We surface those to the user instead of paying the cold cost on
 * every render.
 */
export const ROUTE_TO_COLD_KINDS = new Set<WasmPerFileErrorKind>([
  "output_not_produced",
  "dependency_not_in_bundle",
  "dynamic_filename",
])
```

### Step 2: Re-export from the original sites (transitional)

In `src/services/WasmRuntime.ts`, replace the local declaration with a
re-export so consumers of this file don't break in the same change:

```ts
export type { WasmPerFileErrorKind } from "../errors/index.ts"
```

In `src/services/WarmRenderDispatcher.ts`, replace the local declarations
with re-exports:

```ts
export type { WarmDisabledReason, WasmPerFileErrorKind } from "../errors/index.ts"
export { ROUTE_TO_COLD_KINDS } from "../errors/index.ts"
```

The cross-service import (`WarmRenderDispatcher` → `WasmRuntime`) goes
away — both files now point at `errors/index.ts`.

### Step 3: Migrate direct importers to `errors/index.ts`

Grep for direct consumers and switch them to import from `errors/index.ts`.
Known sites:

- `electron/main/ipc/boilerplate.ts` — already imports `WarmRenderResult`
  from `WarmRenderDispatcher.ts`. The `disabledReason` literal at line 334
  is now checked via `satisfies WarmRenderResult`, so no direct import of
  `WarmDisabledReason` is needed. No change.
- `src/layers/NodeWarmRenderDispatcher.ts` — uses `ROUTE_TO_COLD_KINDS`
  (`src/layers/NodeWarmRenderDispatcher.ts:320`) and assigns
  `disabledReason` literals (lines 177, 194). Switch the
  `ROUTE_TO_COLD_KINDS` import to come from `errors/index.ts`.
- `src/services/WasmRuntime.ts` — `WasmPerFileError.kind` keeps the named
  union via the re-export (or switch to importing from `errors/index.ts`
  directly, since the type is referenced inside the same file).

Run `npx tsc --noEmit` after each file to catch stragglers.

### Step 4: Remove the transitional re-exports

Once all importers are updated, drop the `export type` re-exports from
`WasmRuntime.ts` and `WarmRenderDispatcher.ts`. Final state:

- `errors/index.ts` is the sole declaration site.
- `WasmRuntime.ts` imports `WasmPerFileErrorKind` from `errors/index.ts`.
- `WarmRenderDispatcher.ts` imports `WasmPerFileErrorKind`,
  `WarmDisabledReason`, and `ROUTE_TO_COLD_KINDS` from `errors/index.ts`.
- No cross-service type imports.

## Risk and rollback

Low risk. All changes are name-resolution-only — no runtime behavior shifts.
TypeScript will catch any missed importer. If anything regresses, revert is
a single commit.

## Validation

- `npx tsc --noEmit` — both root and `web/tsconfig.json`.
- `grep -rn "WasmPerFileErrorKind\|WarmDisabledReason\|ROUTE_TO_COLD_KINDS" src electron web`
  — every import line should point at `errors/index.ts` after step 4.

## Estimate

~30-45 minutes of focused work. One commit, or three small commits if you
prefer a step-by-step record.
