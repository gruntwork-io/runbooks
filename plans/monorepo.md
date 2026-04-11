# Monorepo Migration Plan: Bun Workspaces

## Target Structure

```
runbooks/
  package.json              # Root: workspaces config, electron-builder, electron devDeps
  bun.lock                  # Single lockfile for all workspaces
  electron.vite.config.ts   # Stays at root (electron-vite expects this)
  justfile, .mise.toml

  packages/
    core/                   # @runbooks/core (was src/)
      package.json
      tsconfig.json
      domain/, services/, layers/, errors/, test-utils/
      types.ts, mdx.ts, telemetry.ts, watcher.ts, path-validation.ts, remote-source.ts

    shared/                 # @runbooks/shared (was electron/shared/)
      package.json
      tsconfig.json
      channels.ts

  electron/                 # NOT a workspace — built by electron-vite from root context
    main/, preload/, e2e/

  web/                      # @runbooks/web
  cli/                      # @runbooks/cli
  docs/                     # @runbooks/docs
```

**Key decision:** `electron/` stays at root (not a workspace) because electron-builder reads `main` and `build` config from root `package.json`. Making it a workspace would break packaging.

## Workspace Definitions

Root `package.json`:
```json
{
  "workspaces": ["packages/*", "web", "cli", "docs"]
}
```

## Dependency Ownership

| Package | Owns |
|---------|------|
| `@runbooks/core` | effect, chokidar, yaml, ini, @aws-sdk/*, mixpanel |
| `@runbooks/shared` | (types only, no runtime deps) |
| `@runbooks/cli` | commander, @runbooks/core |
| `@runbooks/web` | react, radix, tailwindcss, zod, @runbooks/shared |
| Root | electron, electron-builder, electron-vite, electron-updater, @runbooks/core, @runbooks/shared |

## Import Changes

| Before | After |
|--------|-------|
| `from "../../../src/domain/exec/executor.ts"` | `from "@runbooks/core/domain/exec/executor"` |
| `from "../../../src/types.ts"` | `from "@runbooks/core/types"` |
| `from "../shared/channels.ts"` | `from "@runbooks/shared/channels"` |
| `from "../../src/domain/registry/executable.ts"` | `from "@runbooks/core/domain/registry/executable"` |

## electron-vite Config Changes

Workspace packages must be **bundled** (not externalized) since the packaged app won't have `node_modules/@runbooks/`:

```ts
main: {
  plugins: [externalizeDepsPlugin({
    exclude: ["electron-updater", "@runbooks/core", "@runbooks/shared"],
  })],
  resolve: {
    alias: {
      "@runbooks/core": path.resolve(__dirname, "packages/core"),
      "@runbooks/shared": path.resolve(__dirname, "packages/shared"),
    },
  },
}
```

## Migration Phases

### Phase 1: Create workspace infrastructure
1. Create `packages/core/package.json`, `packages/shared/package.json`, `cli/package.json`
2. Add `"workspaces"` to root `package.json`
3. Delete `web/bun.lock` and `docs/bun.lock`
4. Run `bun install` from root
5. **Test:** `bun install` completes, symlinks exist in `node_modules/@runbooks/`

### Phase 2: Move src/ → packages/core/
6. `git mv src/* packages/core/`
7. Create `packages/core/tsconfig.json`, `cli/tsconfig.json`
8. Delete `tsconfig.src.json`, update root `tsconfig.json` references
9. **Test:** `just typecheck`

### Phase 3: Move electron/shared/ → packages/shared/
10. `git mv electron/shared/channels.ts packages/shared/`
11. Create `packages/shared/tsconfig.json`
12. **Test:** `just typecheck`

### Phase 4: Update electron/ imports
13. Replace all `../../../src/...` → `@runbooks/core/...` in `electron/main/**`
14. Replace `../shared/channels.ts` → `@runbooks/shared/channels` in `electron/preload/`
15. Update `electron.vite.config.ts` (aliases + externalization exclusions)
16. **Test:** `just build`, `just dev`

### Phase 5: Update cli/ imports
17. Replace all `../../src/...` → `@runbooks/core/...` in `cli/**`
18. **Test:** `just compile-test-cli`

### Phase 6: Update web/ imports
19. Add `@runbooks/shared` to `web/package.json`
20. Replace `../../electron/shared/channels.ts` → `@runbooks/shared/channels` in `web/src/api.d.ts`
21. **Test:** `just build`

### Phase 7: Clean up root deps
22. Remove deps that moved to workspaces from root `package.json`
23. Add `@runbooks/core: "workspace:*"`, `@runbooks/shared: "workspace:*"` to root deps
24. **Test:** `just build`, `just test-unit`

### Phase 8: Update test configs
25. Update `vitest.config.ts` includes: `packages/core/**/*.test.ts`
26. **Test:** `just test`

### Phase 9: Verify packaging
27. `just package-local` — verify DMG/app works
28. `just test-e2e` — Playwright passes
29. `just test-runbooks` — CLI binary works

## Risks

| Risk | Mitigation |
|------|-----------|
| electron-builder can't find bundled code | Exclude @runbooks/* from externalization; verify `dist/main/index.js` contains core code inline |
| `packages/core` exports map breaks imports | Skip `exports` field for private packages — Bun resolves via filesystem symlinks |
| Bun compile fails with workspace deps | `bun build --compile` supports workspace resolution; test with `--packages=bundle` if needed |
| Three lockfiles during transition | Delete workspace lockfiles in Phase 1; single root lockfile manages everything |
