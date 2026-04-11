# Subprocess Execution Fix Plan

## Summary

Three issues make script execution unreliable. Fix in order:

1. **Stream.async race condition** (CRITICAL) — process completes but completion events never fire
2. **Template variables not substituted** (HIGH) — raw `{{ .inputs.X }}` in script output
3. **Stop button broken** (HIGH) — frontend never calls exec:cancel, child process not killed

## Issue 1: Stream.async Race (CRITICAL)

**Root cause:** `ChildProcessSpawner.ts` uses `Stream.async` whose `emit.end()` is asynchronous (creates a fiber via `runPromiseExit`). Within `forkDaemon` + `Effect.scoped`, the queue can be shut down before the end signal is delivered.

**Fix:** Replace `Stream.async` with `Stream.asyncPush` (available since Effect 3.6.0). `asyncPush` has synchronous `emit.single()` (returns boolean) and `emit.end()` (returns void). No race possible.

**File:** `src/layers/ChildProcessSpawner.ts` lines 32-54

```typescript
const output: Stream.Stream<OutputLine> = Stream.asyncPush<OutputLine>((emit) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (proc.stdout) {
        const stdoutRl = readline.createInterface({ input: proc.stdout })
        stdoutRl.on("line", (line) => {
          emit.single({ line, source: "stdout" as const })
        })
      }
      if (proc.stderr) {
        const stderrRl = readline.createInterface({ input: proc.stderr })
        stderrRl.on("line", (line) => {
          emit.single({ line, source: "stderr" as const })
        })
      }
      proc.on("close", () => { emit.end() })
      proc.on("error", () => { emit.end() })
    }),
    () => Effect.sync(() => {
      proc.stdout?.destroy()
      proc.stderr?.destroy()
    }),
  ),
  { bufferSize: "unbounded" },
)
```

Also revert `executor.ts` back to `Stream.concat(logStream, completionStream)` since this fix makes concat reliable again.

## Issue 2: Template Variables Not Substituted (HIGH)

**Root cause:** `exec.ts` lines 77-81 iterate `Object.entries(params.templateVarValues)` which yields `["inputs", { Greeting: "Howdy" }]`. The placeholder `{{.inputs}}` replaces with `[object Object]`. It never creates `{{.inputs.Greeting}}`.

**Fix:** Use the existing `BoilerplateRenderer.renderFile` (Go template engine) instead of naive replaceAll.

**File:** `electron/main/ipc/exec.ts` lines 75-82

```typescript
let scriptContent = executable.content
if (params.templateVarValues) {
  const renderer = yield* BoilerplateRenderer
  const escapedVars = shellEscapeDeep(params.templateVarValues)
  scriptContent = yield* renderer.renderFile(scriptContent, escapedVars)
}
```

Add `shellEscapeDeep` helper that recursively shell-escapes string leaf values.

## Issue 3: Stop Button Broken (HIGH)

Three sub-problems:

**3a: Frontend never calls exec:cancel.** `useApiExec.ts` `cancel()` only cleans up listeners. Add `window.api.invoke('exec:cancel').catch(() => {})`.

**3b: Child process not killed on interruption.** Add scope finalizer in `executor.ts` after spawn: `yield* Effect.addFinalizer(() => process.kill.pipe(Effect.ignore))`

**3c: Fiber reference race.** `activeExecFiber` is set after fork returns — cancel during that window is a no-op. Already correct in current code but verify.

## Testing Plan

### Unit tests
- `src/layers/ChildProcessSpawner.test.ts` — real process spawning, verify stream completes for sequential executions
- `executor.test.ts` — verify template substitution, verify kill finalizer
- `useApiExec.test.ts` — verify cancel calls exec:cancel

### E2E tests
- Execute script with template vars → verify substituted output
- Execute 5 scripts sequentially → verify all complete
- Click Stop during execution → verify cancellation

## Investigation Update (2026-04-11)

The stream approach (Stream.async, Stream.asyncPush, Stream.fromIterable) is NOT the root cause. The pattern works in isolation with real child processes (tested 10 sequential executions successfully). The hang is specific to the full codebase's execution path within `runtime.runPromise(Effect.scoped(...))`.

**Hypothesis**: One of the 17 `yield*` calls inside the executor's Effect.gen (temp file creation, script writing, output parsing, env capture) is hanging. Each uses `Effect.tryPromise` wrapping `fs.promises.*` calls. A hanging `fs` operation (e.g., reading from a temp file that was prematurely deleted by a finalizer) would explain the symptoms.

**ROOT CAUSE FOUND AND FIXED**: The `useApiExec` hook's `finally` block (line 213) cleaned up IPC event listeners immediately after `window.api.invoke('exec:run')` resolved. But Electron's `event.sender.send()` events (exec:status, exec:outputs) were still in flight — they arrive as IPC messages that are processed asynchronously. By the time the exec:status event reached the renderer, the listener had already been removed.

**The fix**: Remove the `finally` cleanup. Listeners now persist after execution completes and are cleaned up on the next execution (via `cancel()`) or on component unmount. This matches the Electron IPC delivery model where `event.sender.send()` events arrive after `ipcMain.handle` returns.

**Key diagnostic**: `page.evaluate(() => window.api.invoke("exec:run", ...))` worked instantly, proving the backend was fine. File-based debug logging showed the IPC handler completed in 23ms. The exec:log events arrived but exec:status didn't because the listener was removed in the race window.

## Implementation Order

1. ~~Fix ChildProcessSpawner (Stream.asyncPush)~~ Done but not the root cause
2. Add instrumentation to executor.ts to find exact hang point
3. Fix the identified hang
4. Fix template substitution in exec.ts (DONE)
5. Fix frontend cancel in useApiExec.ts (DONE)
6. Add process kill finalizer to executor.ts (DONE)
7. Write tests
8. Rebuild and verify E2E
