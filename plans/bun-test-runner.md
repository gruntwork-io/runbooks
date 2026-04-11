# Bun Test Runner vs Vitest

## Recommendation: Partial Switch — Backend Only

Migrate backend tests (`src/`, `electron/`) to `bun test`. Keep Vitest for frontend (`web/`) React component tests.

## Why

### Backend tests (safe to switch)
- Use only `describe`, `test`, `expect` — no `vi.mock()`, no jsdom
- Import-only changes required (`from "vitest"` → `from "bun:test"`)
- ~40 test files, estimated 3-4 hours including verification
- Benefit: one less test dependency, faster execution

### Frontend tests (stay on Vitest)
- **Blocker**: jsdom not supported by Bun (only happy-dom, which has DOM behavior differences)
- **Blocker**: 130+ `vi.mock()` calls would need rewriting to `mock.module()`
- 25+ React component test files with @testing-library/react
- Effort: 20+ hours of rework with high risk of subtle behavior changes
- ROI: not worth it — Vitest is fast and proven for React testing

## Compatibility Matrix

| Feature | Backend | Frontend | Bun Support |
|---------|---------|----------|-------------|
| Basic test API | Yes | Yes | Full |
| Module mocking | No | Yes (130+) | Different syntax |
| jsdom environment | No | Required | Not supported |
| @testing-library | No | Yes | Works with happy-dom only |
| Coverage | Yes | Yes | Yes |

## Target Architecture

```bash
bun test src/ electron/              # Bun for backend (fast, native)
bun run vitest run --config web/...  # Vitest for frontend (jsdom, proven)
```

## Implementation Steps (backend only)

1. Create `bunfig.toml` with test config (preload, patterns)
2. Update imports in ~40 backend test files: `from "vitest"` → `from "bun:test"`
3. Update root `package.json` test script
4. Update justfile `test-unit` recipe
5. Verify all backend tests pass with `bun test --coverage`
6. Remove `vitest.config.ts` (root only — keep `web/vitest.config.ts`)
