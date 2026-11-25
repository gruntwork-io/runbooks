#!/usr/bin/env -S bun --no-env-file
/**
 * The fake credential plugin (`@runbooks/core/credential/fake`) as a
 * process, for the credential client's tests through the transport owner
 * and for the contract suite. It imports the core, so it runs from here:
 * a test pins a wrapper script that starts it with Bun
 * (`../integration/credential/pluginBin.ts`).
 *
 * It speaks the transport as the plugins' Rust loop does: one JSON object
 * per line, `configure` first, calls answered as they finish, and when
 * standard input closes it abandons what is running, unanswered, and
 * exits 0. `configure`'s settings may carry `fakeScript`, a `FakeScript`
 * as JSON; without it the script is `FAKE_SCRIPT`. `FAKE_STARTS` in its
 * environment names a file it appends its process id to when it starts.
 */
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { Effect, Fiber } from "effect"
import { FAKE_SCRIPT, type FakeScript, fakeCredentialPlugin } from "@runbooks/core/credential/fake"
import { NodeFileSystemLive } from "../layers/NodeFileSystem.ts"

const environment = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value] as const],
  ),
)
if (environment["FAKE_STARTS"] !== undefined)
  appendFileSync(environment["FAKE_STARTS"], `${process.pid}\n`)

const plugin = Effect.runSync(
  fakeCredentialPlugin((settings) =>
    settings["fakeScript"] === undefined
      ? FAKE_SCRIPT
      : (JSON.parse(settings["fakeScript"]) as FakeScript),
  )(environment).pipe(Effect.provide(NodeFileSystemLive)),
)

const write = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const unreadable = (code: number, message: string) =>
  write({ jsonrpc: "2.0", id: null, error: { code, message, data: { kind: "invalidParams" } } })

/** The calls being answered: closing standard input abandons them. */
const running = new Set<Fiber.Fiber<void>>()

const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  let request: { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown }
  try {
    request = JSON.parse(line)
  } catch {
    return unreadable(-32700, "The line is not JSON.")
  }
  const { id, method, params } = request
  if (typeof method !== "string" || (typeof id !== "number" && typeof id !== "string"))
    return unreadable(-32600, "The line is not a request.")
  const fiber = Effect.runFork(
    plugin
      .answer(method, params ?? {}, (name, notification) =>
        Effect.sync(() =>
          write({ jsonrpc: "2.0", method: name, params: { ...notification, request: id } }),
        ),
      )
      .pipe(
        Effect.match({
          onSuccess: (result) => write({ jsonrpc: "2.0", id, result }),
          onFailure: (refusal) =>
            write({
              jsonrpc: "2.0",
              id,
              error: {
                code: refusal.kind === "invalidParams" ? -32602 : -32000,
                message: refusal.message,
                data: { ...refusal.data, kind: refusal.kind },
              },
            }),
        }),
        Effect.provide(NodeFileSystemLive),
      ),
  )
  running.add(fiber)
  fiber.addObserver(() => running.delete(fiber))
})
lines.on("close", () => {
  void Effect.runPromise(
    Effect.forEach(Array.from(running), Fiber.interrupt, { discard: true }),
  ).then(() => process.exit(0))
})
