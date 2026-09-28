/**
 * The aws:check-region reply as the renderer receives it. useAwsAuth shows
 * `warning` on the success card whenever the reply has one, so a reply that
 * carries anything but a real "region is not enabled" sentence puts a red
 * herring there (it once said a bare "true").
 *
 * The send-outcome cases run the real handler, shared runtime (AppLive),
 * domain checkRegion and AwsSdkClient layer; only `electron` is replaced, plus
 * AccountClient's `send` at the network boundary. The layer turns every
 * rejected send into `true`, so nothing at that boundary ends the check in a
 * defect or an interruption: those cases stub `runtime.runPromise` once and
 * exercise only the handler's own catch.
 */
import { describe, it, expect, afterEach, spyOn } from "bun:test"
import { Effect } from "effect"
import { AccountClient, AccessDeniedException, GetRegionOptStatusCommand } from "@aws-sdk/client-account"
import { mockElectron } from "../test-utils/mock-electron.ts"

type Handler = (event: unknown, params?: unknown) => unknown
const handlers = new Map<string, Handler>()

mockElectron({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
})

const { registerAwsHandlers } = await import("./aws.ts")
const { runtime } = await import("./runtime.ts")

registerAwsHandlers()

const REGION = "ap-east-1"
/** What useAwsAuth sends: the credential fields flat, next to the region. */
const PARAMS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "session-token-EXAMPLE",
  region: REGION,
}

type CheckRegionReply = { enabled: boolean; warning?: string }

const invokeCheckRegion = async (): Promise<CheckRegionReply> => {
  const handler = handlers.get("aws:check-region")
  if (!handler) throw new Error("no handler for aws:check-region")
  const reply = (await handler({}, PARAMS)) as CheckRegionReply
  expect(reply.warning).not.toBe("true")
  return reply
}

const spies: { mockRestore: () => void }[] = []

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

const stubAccount = (reply: () => Promise<unknown>) => {
  const spy = spyOn(AccountClient.prototype, "send").mockImplementation(reply as never)
  spies.push(spy)
  return spy
}

/** The arguments of every console.error the handler's own logger wrote. */
const captureHandlerErrors = () => {
  const spy = spyOn(console, "error").mockImplementation(() => {})
  spies.push(spy)
  return () => spy.mock.calls.filter((args) => args[0] === "[ipc:aws]")
}

describe("aws:check-region", () => {
  it.each([
    ["an AccessDeniedException", () => new AccessDeniedException({ message: "not authorized", $metadata: {} })],
    ["a network TypeError", () => new TypeError("fetch failed")],
  ])("fails open when GetRegionOptStatus rejects with %s", async (_label, makeError) => {
    stubAccount(() => Promise.reject(makeError()))
    const handlerErrors = captureHandlerErrors()

    const reply = await invokeCheckRegion()

    expect(reply).toStrictEqual({ enabled: true })
    // The layer answers this itself; it is not the handler's crash path.
    expect(handlerErrors()).toEqual([])
  })

  it("warns that a disabled region is not enabled", async () => {
    const send = stubAccount(() => Promise.resolve({ RegionOptStatus: "DISABLED" }))

    expect(await invokeCheckRegion()).toStrictEqual({
      enabled: false,
      warning: `Region ${REGION} is not enabled for this AWS account`,
    })
    const command = send.mock.calls[0][0] as unknown as GetRegionOptStatusCommand
    expect(command).toBeInstanceOf(GetRegionOptStatusCommand)
    expect(command.input).toEqual({ RegionName: REGION })
  })

  it("reports an enabled region as enabled, with no warning", async () => {
    stubAccount(() => Promise.resolve({ RegionOptStatus: "ENABLED" }))

    expect(await invokeCheckRegion()).toStrictEqual({ enabled: true })
  })

  it.each([
    ["a defect", Effect.die(new Error("boom"))],
    ["an interruption", Effect.interrupt],
  ])("fails open, and logs without the credentials, when the check ends in %s", async (_label, outcome) => {
    const runPromise = spyOn(runtime, "runPromise").mockImplementationOnce(
      (() => Effect.runPromise(outcome)) as unknown as typeof runtime.runPromise,
    )
    spies.push(runPromise)
    const handlerErrors = captureHandlerErrors()

    const reply = await invokeCheckRegion()

    expect(reply).toStrictEqual({ enabled: true })
    expect(runPromise).toHaveBeenCalledTimes(1)
    const logged = handlerErrors()
    expect(logged).toHaveLength(1)
    // Render each argument the way the console shows it. String() would turn
    // a logged params or credentials object into "[object Object]" and hide
    // any secret inside it; makeLogger only scrubs strings and Errors.
    const text = logged[0]
      .map((arg) => (typeof arg === "string" ? arg : Bun.inspect(arg, { depth: Infinity })))
      .join(" ")
    expect(text).toContain("Region opt-in check crashed")
    for (const secret of [PARAMS.accessKeyId, PARAMS.secretAccessKey, PARAMS.sessionToken]) {
      expect(text).not.toContain(secret)
    }
  })
})
