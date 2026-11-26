# Draft: WP 2.9, the in-process transport (not committed; add files by name)

Goal: a client in the same process drives the Engine only through EngineProtocol, getting
typed successes, typed errors and bounded event streams, with its origin fixed by the
transport, through the same schema encoding IPC will use.

Stated size: 2 branches (contract changes the transport needs; handlers layer + in-process
transport + tests through the client), ~6 files, ~900 lines with tests.

Branches: rebuild/p2-transport-contract (PR 31, base #560), rebuild/p2-transport (PR 32).

## Survey
- effect 4.1.2 rpc: RpcTest.makeClient = RpcServer.makeNoSerialization + RpcClient.makeNoSerialization:
  no encoding at all. RpcServer.make / RpcClient.make encode through `Protocol.codecFor`
  (Schema.toCodecJson for RpcSerialization.json). Acks: server waits per chunk when
  `supportsAck`; client queue per stream bounded (streamBufferSize default 16), acks after offerAll.
- Middleware gets `{ client, requestId, rpc, payload, headers }`; headers come from the client.
- Engine has no ResolveApproval; settings commands are SettingsStore's (get/change/watch).
- core exports no engine/transport path yet (tsconfig.packages.json); knip does not cover packages/.

## Commits
- rebuild/p2-transport-contract: 77514a77 (Engine.resolveApproval), e3d17742 (watch ends with store)
- rebuild/p2-transport: a2e460b2 (handlers + in-process transport + tests)

## Decisions
1. Contract: Engine gains resolveApproval (origin check in engine, not transport). Every approval is
   UnknownApproval until 3.7.
2. Contract: SettingsStore.watch ends when the store closes (found: WatchSettings hung after engine
   close over the transport). Deferred + Stream.interruptWhen, not PubSub.shutdown (take would interrupt).
3. Handlers need Engine | SettingsStore; settings commands go straight to the store (no engine
   pass-through methods).
4. One server per client; origin fixed via CallerMiddleware at make; headers/payload never read.
5. RpcServer.make/RpcClient.make with RpcSerialization.json.codecFor; messages handed directly
   (no JSON text step: a probe showed no test depends on it; toCodecJson already yields JSON values).
6. Bounds: acks on + direct delivery; client buffer = effect default 16 per call; measured 18 read
   ahead (16 + taken + held). No cap on requests in flight per client (in-process caller is our code).
7. Comparison oracle for encoding: effect's HTTP rpc protocol in memory (toHttpEffect + toWebHandler
   + FetchHttpClient with a Fetch that calls the handler).
8. No core export path for engine/transport yet: 2.10 adds it with its first import.

9. Secrets one way: a test walks every answer/error/stream-element schema via
   SchemaRepresentation.toRepresentation for the "effect/schema/Redacted" id (toJson fails on the
   settings schemas, so the walk reads the document object). Only ActOnCredential's payload holds one.
10. RpcServer concurrency left unbounded: a numeric cap is a permit per handler for its life, so open
   streams would block other commands.

## Failed attempts
- Tests forked Stream.runCollect(Events)/WatchSettings and acted at once: the subscription began
  after CloseSession (UnknownSession / timeout). Fixed with `subscribed` (asQueue, take the first).
- WatchSettings hung after the engine layer closed: became contract change 2.
- A JSON text step (JSON.parse(JSON.stringify)) between client and server: no test could tell it
  apart (mutating it away left all tests green), so it was dropped as untested code.
- standIn(Partial<handlers>) typed R as any: replaced by a concrete UNUSED object spread.
- Payload-origin mutation (m2b) survives: payload decoded before middleware, no schema has origin;
  m2c (schema gains origin + middleware reads it) is caught by the caller test.
