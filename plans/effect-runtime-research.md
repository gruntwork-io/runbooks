# Effect Runtime Research: Stream.async + forkDaemon Interaction

## Problem

After ~3 sequential script executions via the same IPC handler, the Effect fiber within `forkDaemon` stops resuming from `Stream.async` callbacks. Scripts run and produce output (log lines appear), but the completion events (status, outputs) never fire.

## Root Cause

The issue is a **scope/queue lifecycle race** in `Stream.async` when used inside `Effect.scoped` + `Effect.forkDaemon`.

### How Stream.async Works

`Stream.async` (effect/internal/stream.js:186-205) creates a **Queue** via `Effect.acquireRelease`:
```
acquireRelease(createQueue, queue => Queue.shutdown(queue))
```

Events emitted via `emit.single()` and `emit.end()` call `Queue.offer()` on this queue. The consumer (`Stream.runForEach`) reads from the queue.

### How emit.end() Works

`emit.end()` (effect/internal/stream/emit.js:25-26) is fire-and-forget:
```javascript
end() { return this(Effect.fail(Option.none())); }
```

This creates a new fiber via `runPromiseExit` to offer the end signal to the queue. The fiber runs asynchronously — there's **no guarantee** it executes before other pending work.

### How forkDaemon + Scoped Interacts

In `electron/main/ipc/exec.ts`:
```typescript
Effect.forkDaemon(
  Effect.scoped(
    Effect.gen(function* () {
      // ... creates streams with Stream.async ...
      yield* Stream.runForEach(logStream, ...)
      // ... completion ...
    })
  )
)
```

1. `Effect.scoped` creates a local scope
2. `Stream.async` creates a Queue in that scope (with shutdown finalizer)
3. `Stream.runForEach` consumes the queue
4. When `proc.on("close")` fires, `emit.end()` tries to `Queue.offer`
5. **Race**: if the scope's finalizer (Queue.shutdown) runs before `emit.end()`'s async fiber offers the end signal, the offer hangs forever
6. `Stream.runForEach` never completes → daemon fiber hangs

### Why First 1-2 Executions Work

Timing luck: fast-completing processes fire `emit.end()` before scope cleanup runs. By the 3rd+ execution, accumulated microtask scheduling delays cause the race to trigger.

## Fix Options

### Option A: Avoid Stream.async for process output (recommended)
Replace `Stream.async` in `ChildProcessSpawner` with eager line collection + `Stream.fromIterable`. Process output is collected into an array via readline, then emitted as a batch when the process closes. Already partially implemented — needs the IPC handler to use the two-phase approach (logStream + completionEffect).

### Option B: Don't use forkDaemon for exec
Use `Effect.fork` (which ties to the parent scope) or run the execution directly in the handler. This keeps the scope alive for the full duration.

### Option C: Use Stream.asyncScoped
Effect provides `Stream.asyncScoped` which ties the stream's scope to the consumer's scope, avoiding premature queue shutdown. But this requires careful integration.

## Key Files

- `electron/main/ipc/exec.ts` — IPC handler using forkDaemon
- `src/domain/exec/executor.ts` — returns logStream + completionEffect 
- `src/layers/ChildProcessSpawner.ts` — Stream.async for process output
- `node_modules/effect/dist/esm/internal/stream.js:186-205` — Stream.async impl
- `node_modules/effect/dist/esm/internal/stream/emit.js:25-26` — emit.end()
- `node_modules/effect/dist/esm/internal/fiberRuntime.js:1616` — forkDaemon uses globalScope
