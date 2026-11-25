#!/usr/bin/env -S bun --no-env-file
/**
 * A plugin binary for the transport owner's tests (`../layers/NodePluginProcess.test.ts`).
 * The tests copy it into a temporary bin folder as `runbooks-credential-stub`
 * and pin its SHA-256 there, so the owner checks, spawns and talks to it as
 * it would a released plugin. It imports nothing outside Node, since it runs
 * from that copy.
 *
 * It speaks the transport like the plugins' Rust loop: one JSON object per
 * line, `configure` first (any other call before it gets `notConfigured`),
 * and it exits when standard input closes. Each method scripts one
 * behaviour, by name. Its environment scripts `configure`:
 * - `STUB_SPEAKS`: the protocol version it accepts, "1" by default. A
 *   `configure` for another gets error kind `unsupportedProtocolVersion`.
 * - `STUB_ANSWERS`: the protocol version its `configure` result names, when
 *   it accepts one but names another.
 * - `STUB_CONFIGURE=hang`: never answers `configure`.
 * - `STUB_IGNORES_STDIN=1`: keeps running after standard input closes.
 * - `STUB_STARTED`: a file it writes its process id to when it starts.
 */
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

if (process.env.STUB_STARTED !== undefined)
  writeFileSync(process.env.STUB_STARTED, String(process.pid))

type Params = { readonly [key: string]: unknown }

const speaks = process.env.STUB_SPEAKS ?? "1"
let configured = false
/** Each method's limit, from `configure`'s `callTimeoutsMillis`. */
let limits: Params = {}

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const answer = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result })
const refuse = (id: unknown, kind: string, message: string, data: Params = {}) =>
  write({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { ...data, kind } } })
const exit = (code: number, stderr: string) =>
  process.stderr.write(stderr, () => process.exit(code))

const methods: Record<string, (id: number, params: Params) => void> = {
  configure: (id, params) => {
    if (process.env.STUB_CONFIGURE === "hang") return
    if (params.protocolVersion !== speaks) {
      refuse(id, "unsupportedProtocolVersion", `this plugin speaks ${speaks}`)
      return
    }
    configured = true
    const given = params.callTimeoutsMillis
    limits = typeof given === "object" && given !== null ? { ...given } : {}
    answer(id, {
      protocolVersion: process.env.STUB_ANSWERS ?? speaks,
      driverVersion: "0.0.0",
      received: { ...params },
      pid: process.pid,
    })
  },
  echo: (id, params) => answer(id, { ...params }),
  /** Echoes `word` after `millis`, so a later call can be answered first. */
  later: (id, params) => setTimeout(() => answer(id, { word: params.word }), Number(params.millis)),
  env: (id) => answer(id, { ...process.env }),
  /** Notifications `count.tick` 1 to `n`, then the result. */
  count: (id, params) => {
    const n = Number(params.n)
    for (let i = 1; i <= n; i++)
      write({ jsonrpc: "2.0", method: "count.tick", params: { request: id, i } })
    answer(id, { n })
  },
  /** A result line of exactly `bytes` bytes, without its newline. */
  line: (id, params) => {
    const empty = JSON.stringify({ jsonrpc: "2.0", id, result: { pad: "" } }).length
    answer(id, { pad: "x".repeat(Number(params.bytes) - empty) })
  },
  hang: () => {},
  /** Answers `timedOut` a second before its limit, as a plugin does with a call it cannot finish. */
  budget: (id) =>
    setTimeout(
      () => refuse(id, "timedOut", "the stub ran out of time"),
      Number(limits.budget) - 1_000,
    ),
  exit: (_id, params) => exit(Number(params.code), String(params.stderr)),
  /** `bytes` of standard error, ending in `tail`, then exits 1. */
  flood: (_id, params) => {
    const tail = String(params.tail)
    process.stderr.write("e".repeat(Number(params.bytes) - tail.length))
    exit(1, tail)
  },
  unknownId: (id) => answer(id + 1000, {}),
  notJson: () => process.stdout.write("this is not json\n"),
  idAndMethod: (id) => write({ jsonrpc: "2.0", id, method: "echo", params: {} }),
  nullId: () =>
    write({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "the line is not JSON", data: { kind: "invalidParams" } },
    }),
  notifyUnknown: (id) =>
    write({ jsonrpc: "2.0", method: "count.tick", params: { request: id + 1000, i: 1 } }),
  /** A notification for a call that streams nothing, then its result. */
  notifyCall: (id) => {
    write({ jsonrpc: "2.0", method: "count.tick", params: { request: id, i: 1 } })
    answer(id, {})
  },
  remoteError: (id, params) =>
    refuse(id, String(params.kind), "the stub refused", { detail: params.detail ?? null }),
  /** Starts `sleep` in the stub's process group: killing the stub alone leaves it running. */
  child: (id) => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" })
    answer(id, { pid: child.pid ?? 0 })
  },
}

const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const request = JSON.parse(line) as { id: number; method: string; params?: Params }
  const run = methods[request.method]
  if (run === undefined) {
    refuse(request.id, "invalidParams", `no method ${request.method}`)
  } else if (!configured && request.method !== "configure") {
    refuse(request.id, "notConfigured", `${request.method} was called before configure`)
  } else {
    run(request.id, request.params ?? {})
  }
})
lines.on("close", () => {
  if (process.env.STUB_IGNORES_STDIN === "1") setInterval(() => {}, 60_000)
  else process.exit(0)
})
