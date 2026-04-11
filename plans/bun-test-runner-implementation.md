# Bun Test Runner Migration -- Implementation Notes

## Status: Code changes complete, needs verification

## What was done

### Import migration (15 files)
All backend test files had their import changed from `from "vitest"` to `from "bun:test"`:

**src/ (13 files):**
- `src/mdx.test.ts`
- `src/remote-source.test.ts`
- `src/path-validation.test.ts`
- `src/domain/exec/script.test.ts`
- `src/domain/exec/executor.test.ts`
- `src/domain/git/operations.test.ts`
- `src/domain/files/manifest.test.ts`
- `src/domain/boilerplate/config.test.ts`
- `src/domain/registry/executable.test.ts`
- `src/domain/github/auth.test.ts`
- `src/domain/aws/auth.test.ts`
- `src/domain/workspace/workspace.test.ts`
- `src/domain/session/manager.test.ts`

**electron/ (2 files):**
- `electron/main/remote.test.ts`
- `electron/main/cli.test.ts`

### APIs used (all supported by bun:test)
- `describe`, `it`, `expect` -- all 15 files
- `beforeEach` -- 1 file (manager.test.ts)
- `it.each` -- 2 files (script.test.ts, operations.test.ts)
- No `vi.mock()`, `vi.fn()`, or Vitest-specific features used

### Infrastructure changes
- **package.json**: Updated test scripts to use `bun test src/ electron/` for backend, `vitest run --config web/vitest.config.ts` for web
- **justfile**: Split `test-unit` into `test-backend` (bun test) and `test-web` (vitest), with `test-unit` running both
- **vitest.config.ts**: Replaced root config with a re-export of `web/vitest.config.ts` (backend no longer uses vitest)

### What was NOT changed
- `web/` tests remain on Vitest (jsdom, vi.mock, @testing-library)
- `web/vitest.config.ts` is untouched

## Verification needed

Run these commands to verify the migration works:

```bash
bun test src/
bun test electron/
# Or combined:
bun test src/ electron/
```

## Key finding
None of the 15 backend test files use any Vitest-specific features beyond the basic test API (`describe`, `it`, `expect`, `beforeEach`, `it.each`). All of these are supported identically by `bun:test`, making this a pure import-swap migration with zero behavioral changes.
