/** GitAuth's agent adapter: what get_block shows, and actions reaching the block's own handlers. */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderWithAgent, askAgent, availableActions } from "@/test/agent-harness"

const handlers = {
  startOAuth: vi.fn(),
  setAuthMethod: vi.fn(),
  setPatToken: vi.fn(),
  handlePatSubmit: vi.fn(),
  reloadDetection: vi.fn(),
  handleHostSelect: vi.fn(),
  reAuthenticate: vi.fn(),
}
let hookState: Record<string, unknown> = {}

vi.mock("../hooks/useGitAuth", () => ({
  useGitAuth: () => ({
    authStatus: "pending",
    authMethod: "pat",
    detectionStatus: "done",
    userInfo: null,
    errorMessage: null,
    patToken: "",
    showPatToken: false,
    setShowPatToken: vi.fn(),
    cancelOAuth: vi.fn(),
    resetAuth: vi.fn(),
    resetDetectionState: vi.fn(),
    clearRegisteredOutputs: vi.fn(),
    applySchannel: vi.fn(),
    retryUnreachable: vi.fn(),
    effectiveClientId: "client-id",
    isCustomClientId: false,
    oauthUnavailableReason: null,
    hostSelectable: true,
    availableHosts: ["github.com", "ghe.example.com"],
    selectedHost: "github.com",
    ...handlers,
    ...hookState,
  }),
}))

import { GitAuth } from "../GitAuth"

beforeEach(() => {
  hookState = {}
  for (const fn of Object.values(handlers)) fn.mockClear()
})

describe("GitAuth agent adapter", () => {
  it("is controllable, and lists its sign-in actions", async () => {
    const api = renderWithAgent(<GitAuth id="git" />)
    const session = await askAgent(api, { op: "get_session" })
    expect(session.blocks).toContainEqual(
      expect.objectContaining({
        id: "git",
        type: "GitAuth",
        status: "pending",
        controllable: true,
      }),
    )
    const detail = await askAgent(api, { op: "get_block", blockId: "git" })
    expect(availableActions(detail)).toEqual(
      expect.arrayContaining([
        "reload_detection",
        "select_host",
        "start_browser_sign_in",
        "sign_in_with_token",
      ]),
    )
    expect(availableActions(detail)).not.toContain("sign_out")
  })

  it("starts a browser sign-in and says what the person must do", async () => {
    const api = renderWithAgent(<GitAuth id="git" />)
    expect(
      await askAgent(api, {
        op: "act_on_block",
        blockId: "git",
        action: "start_browser_sign_in",
        params: {},
      }),
    ).toMatchObject({ ok: true })
    expect(handlers.setAuthMethod).toHaveBeenCalledWith("oauth")
    expect(handlers.startOAuth).toHaveBeenCalled()
  })

  it("reports the device code as needsHuman while signing in", async () => {
    hookState = {
      authStatus: "authenticating",
      oauthUserCode: "ABCD-1234",
      oauthVerificationUri: "https://github.com/login/device",
    }
    const api = renderWithAgent(<GitAuth id="git" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "git" })
    expect(detail.status).toBe("running")
    expect(detail.needsHuman).toContain("ABCD-1234")
  })

  it("signs in with a token through the token form's submit", async () => {
    const api = renderWithAgent(<GitAuth id="git" />)
    await askAgent(api, {
      op: "act_on_block",
      blockId: "git",
      action: "sign_in_with_token",
      params: { token: "ghp_x" },
    })
    expect(handlers.setPatToken).toHaveBeenCalledWith("ghp_x")
    await vi.waitFor(() => expect(handlers.handlePatSubmit).toHaveBeenCalled())
  })

  it("picks a host, and refuses an unknown action", async () => {
    const api = renderWithAgent(<GitAuth id="git" />)
    await askAgent(api, {
      op: "act_on_block",
      blockId: "git",
      action: "select_host",
      params: { host: "ghe.example.com" },
    })
    expect(handlers.handleHostSelect).toHaveBeenCalledWith("ghe.example.com")
    expect(
      await askAgent(api, { op: "act_on_block", blockId: "git", action: "nope", params: {} }),
    ).toMatchObject({ ok: false })
  })

  it("reports the signed-in account", async () => {
    hookState = {
      authStatus: "authenticated",
      userInfo: { login: "octocat" },
      detectionSource: "cli",
    }
    const api = renderWithAgent(<GitAuth id="git" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "git" })
    expect(detail).toMatchObject({
      status: "success",
      state: { signedInAs: "octocat", detectedFrom: "cli" },
    })
    expect(availableActions(detail)).toContain("sign_out")
    expect(availableActions(detail)).toContain("select_provider")
  })

  it("offers no provider switch when the block hides the picker", async () => {
    const api = renderWithAgent(<GitAuth id="git" hideProviderSelect />)
    const detail = await askAgent(api, { op: "get_block", blockId: "git" })
    expect(availableActions(detail)).not.toContain("select_provider")
  })
})
