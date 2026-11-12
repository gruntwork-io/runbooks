/**
 * The aws:send and google:send replies as the renderer receives them. Runs the
 * real handlers, shared runtime, domain rules and SDK layers; only `electron`
 * is replaced, plus fetch at the network boundary.
 */
import { describe, it, expect, afterAll, afterEach, spyOn } from "bun:test"
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
const { registerGoogleHandlers } = await import("./google.ts")
const { resetGoogleCredentialRegistry, setActiveCredential } =
  await import("./google-credential-registry.ts")

registerAwsHandlers()
registerGoogleHandlers()

const invoke = (channel: string, params: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, params))
}

const fetched: string[] = []
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
  fetched.push(url)
  return new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}) as never)

afterEach(() => {
  fetched.length = 0
  resetGoogleCredentialRegistry()
})

afterAll(() => fetchSpy.mockRestore())

const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }

describe("aws:send", () => {
  it("sends a read and returns AWS's answer", async () => {
    const reply = await invoke("aws:send", {
      credentials: CREDENTIALS,
      request: {
        method: "GET",
        url: "https://iam.amazonaws.com/?Action=ListRoles&Version=2010-05-08",
        headers: {},
      },
    })
    expect(reply).toEqual({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    expect(fetched).toEqual(["https://iam.amazonaws.com/?Action=ListRoles&Version=2010-05-08"])
  })

  it("rejects a write without sending it", async () => {
    const sent = invoke("aws:send", {
      credentials: CREDENTIALS,
      request: { method: "GET", url: "https://iam.amazonaws.com/?Action=DeleteRole", headers: {} },
    })
    await expect(sent).rejects.toThrow("only reads")
    expect(fetched).toEqual([])
  })
})

describe("google:send", () => {
  it("sends with the named block's credential, billed to its project", async () => {
    setActiveCredential("workspace", {
      ref: { kind: "access_token", accessToken: "ya29.token" },
      principal: "admin@example.com",
      credentialType: "access_token",
      projectId: "runbooks-project",
    })
    await invoke("google:send", {
      blockId: "workspace",
      request: {
        method: "GET",
        url: "https://admin.googleapis.com/admin/directory/v1/users",
        headers: {},
      },
    })
    const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit
    expect((init.headers as Record<string, string>)["x-goog-user-project"]).toBe("runbooks-project")
  })

  it("rejects a block that hasn't signed in", async () => {
    const sent = invoke("google:send", {
      blockId: "workspace",
      request: { method: "GET", url: "https://admin.googleapis.com/", headers: {} },
    })
    await expect(sent).rejects.toThrow("isn't signed in")
    expect(fetched).toEqual([])
  })
})
