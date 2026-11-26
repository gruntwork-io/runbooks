# Draft: WP 2.12, the plugin transport owner (not committed; add files by name)

Status: done, 3 branches committed locally, not pushed. PR bodies in scratchpad/prs/p2-plugin-{contract,owner,lint}.md.

| Branch | Tip | Commit |
|---|---|---|
| rebuild/p2-plugin-contract | 2e1c50c9 | rebuild: the transport contract, as the owner needs it |
| rebuild/p2-plugin-owner | 1b0f243b | rebuild: the plugin transport owner, over node:child_process |
| rebuild/p2-plugin-lint | 514ff05f | rebuild: a lint keeps plugin binaries to the transport owner |

Base: rebuild/p2-cli-test 78953061 (#570).

## Decisions (final; full text in the PR bodies)
1. open(protocol, plugin, env, configure): the owner sends configure first with protocolVersion + caller.
2. Any transport error ends the session; a remote error ends only its call; giving up a call ends it (stdin close is the only cancel).
3. Binary = runbooks-<kind>-<name>[.exe] in binDir, found by (kind, name); binaryName exported by the owner.
4. Kill: POSIX process group (detached + kill(-pid) once, after stdin close + grace). Windows: child.kill only.
5. Stderr is a tail, never an error; PluginTooLarge drops "stderr". A request line over the cap fails only that call.
6. STREAM_BUFFER 16 (backpressure, not in LIMITS). No cap on calls in flight.
7. Lint: lexical on runbooks-<kind>- (kinds read from PluginKind; lint fails if unreadable) or a string ending in runbooks-.

## Failed attempts
- Bun's toThrow passes when the function returns an Error; decoded TaggedErrors are Errors. Two contract assertions use decodeUnknownOption instead.
- First stream-cancel design deadlocked: the reader could block in Queue.offer on a cancelled stream. Fixed: shut the queue down before cancelling, and ignore output once stdin is closed.
- Two mutations first uncaught (env mutation broke syntax; session end leaving the plugin was masked by scope close). Both fixed before commit.
