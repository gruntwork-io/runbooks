import { describe, expect, it } from "bun:test"
import { Effect, Stream } from "effect"
import type { EngineClient } from "@runbooks/core/protocol"
import { type EngineBridge, makeEngineClient } from "./engine.ts"

// The window's client over a stand-in bridge, behind which the test plays
// main: it reads each message the client sends and answers in the JSON main
// sends.

/** A message the client sent, as main reads it. */
interface Sent {
  readonly _tag: string
  readonly id?: string | number
  readonly tag?: string
  readonly requestId?: string | number
}

/** The settings the engine shows, encoded. */
const VIEW = {
  settings: {
    theme: "system",
    instructionMode: false,
    runbookWidth: null,
    askAboutGeneratedFiles: true,
    caBundleFile: null,
    proxy: null,
    agentAccess: false,
    confirmAgentRuns: true,
    recentGitHubHosts: [],
    lastSelectedGitHubHost: null,
    recentGitLabHosts: [],
    lastSelectedGitLabHost: null,
  },
  file: "/user data/settings.json",
  problems: [],
}

const success = (requestId: string | number | undefined, value: unknown) => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Success", value },
})

/**
 * A bridge to a stand-in main, which `answer` plays: it gets each message
 * the client sends, and a way to reply, which delivers on a later turn as
 * IPC does.
 */
const fakeBridge = (answer: (sent: Sent, reply: (message: unknown) => void) => void = () => {}) => {
  const listeners = new Set<(message: string) => void>()
  const sent: Sent[] = []
  const push = (text: string) => {
    for (const listener of listeners) listener(text)
  }
  const reply = (message: unknown) => setTimeout(() => push(JSON.stringify(message)), 0)
  const bridge: EngineBridge = {
    send: (text) => {
      const message: Sent = JSON.parse(text)
      sent.push(message)
      answer(message, reply)
    },
    onMessage: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { bridge, sent, listeners, push }
}

const withClient = <A, E>(
  bridge: EngineBridge,
  use: (client: EngineClient) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeEngineClient(bridge), use)).pipe(Effect.timeout("2 seconds")),
  )

describe("the window's engine client", () => {
  it("sends each call as one JSON message, and decodes main's answer", async () => {
    const fake = fakeBridge((sent, reply) => {
      if (sent.tag === "GetSettings") reply(success(sent.id, VIEW))
    })
    const view = await withClient(fake.bridge, (client) => client.GetSettings())
    expect(view.file).toBe("/user data/settings.json")
    expect(fake.sent.map((message) => [message._tag, message.tag])).toEqual([
      ["Request", "GetSettings"],
    ])
  })

  it("acks each chunk of a stream once it has taken it, and no sooner", async () => {
    let chunks = 0
    const fake = fakeBridge((sent, reply) => {
      const theme = ["light", "dark"][chunks++]
      if (sent.tag === "WatchSettings" || (sent._tag === "Ack" && theme !== undefined))
        reply({
          _tag: "Chunk",
          requestId: sent.id ?? sent.requestId,
          values: [{ ...VIEW, settings: { ...VIEW.settings, theme } }],
        })
    })
    const themes = await withClient(fake.bridge, (client) =>
      client.WatchSettings().pipe(
        Stream.take(2),
        Stream.map((view) => view.settings.theme),
        Stream.runCollect,
      ),
    )
    expect(themes).toEqual(["light", "dark"])
    expect(fake.sent.slice(0, 3).map((message) => message._tag)).toEqual(["Request", "Ack", "Ack"])
  })

  it("fails a call whose message the bridge refuses, instead of waiting on it", async () => {
    const bridge: EngineBridge = {
      send: () => {
        throw new RangeError("A message to the engine is at most 1048576 characters.")
      },
      onMessage: () => () => {},
    }
    const failed = await withClient(bridge, (client) => Effect.flip(client.GetSettings()))
    expect(failed._tag).toBe("RpcClientError")
    expect(failed.message).toContain("The engine bridge refused the message.")
  })

  it("drops what main sends that is not an answer, a chunk or a defect", async () => {
    const fake = fakeBridge((sent, reply) => {
      if (sent.tag !== "GetSettings") return
      fake.push("not JSON")
      fake.push(JSON.stringify({ _tag: "Pong" }))
      fake.push(JSON.stringify({ _tag: "Exit", requestId: sent.id }))
      fake.push(JSON.stringify({ _tag: "Chunk", requestId: sent.id, values: [] }))
      reply(success(sent.id, VIEW))
    })
    const view = await withClient(fake.bridge, (client) => client.GetSettings())
    expect(view.file).toBe("/user data/settings.json")
  })

  it("answers a call while a stream's full buffer waits on the reader making it", async () => {
    // A hundred settings in one chunk fill the stream's buffer of 16, and
    // its reader asks for the settings again for each.
    const fake = fakeBridge((sent, reply) => {
      if (sent.tag === "WatchSettings")
        reply({
          _tag: "Chunk",
          requestId: sent.id,
          values: Array.from({ length: 100 }, () => VIEW),
        })
      if (sent.tag === "GetSettings") reply(success(sent.id, VIEW))
    })
    const asked = await withClient(fake.bridge, (client) =>
      client.WatchSettings().pipe(
        Stream.mapEffect(() => client.GetSettings()),
        Stream.take(40),
        Stream.runCollect,
      ),
    )
    expect(asked).toHaveLength(40)
  })

  it("stops hearing the bridge when its scope closes", async () => {
    const fake = fakeBridge()
    await withClient(fake.bridge, () => Effect.sync(() => expect(fake.listeners.size).toBe(1)))
    expect(fake.listeners.size).toBe(0)
  })
})
