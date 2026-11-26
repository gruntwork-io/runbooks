/**
 * GoogleAuth's agent adapter, through the block's real handlers and a fake
 * main: the person signs in with a key, and the agent picks the project.
 */
import { describe, it, expect, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { renderWithAgent, askAgent, availableActions } from "@/test/agent-harness"

vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import GoogleAuth from "../GoogleAuth"

const SA_KEY = JSON.stringify({
  type: "service_account",
  project_id: "key-project",
  client_email: "sa@key-project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nzzz\n-----END PRIVATE KEY-----\n",
})

describe("GoogleAuth agent adapter", () => {
  it("lists its sign-in actions", async () => {
    const api = renderWithAgent(<GoogleAuth id="gcp" detectCredentials={false} />, {
      "google:oauth-available": (() => ({ available: true })) as never,
    })
    const detail = await askAgent(api, { op: "get_block", blockId: "gcp" })
    expect(availableActions(detail)).toEqual(
      expect.arrayContaining(["sign_in_with_gcloud", "start_browser_sign_in", "retry_detection"]),
    )
    expect(availableActions(detail)).not.toContain("select_project")
  })

  it("offers only the sign-in actions of the listed methods", async () => {
    const api = renderWithAgent(
      <GoogleAuth id="gcp" detectCredentials={false} methods={["service_account"]} />,
      { "google:oauth-available": (() => ({ available: true })) as never },
    )
    const offered = availableActions(await askAgent(api, { op: "get_block", blockId: "gcp" }))
    expect(offered).not.toContain("sign_in_with_gcloud")
    expect(offered).not.toContain("start_browser_sign_in")
    expect(offered).toContain("retry_detection")
  })

  it("picks the project from the block's picker", async () => {
    const api = renderWithAgent(<GoogleAuth id="gcp" />, {
      "google:oauth-available": (() => ({ available: true })) as never,
      "google:credential-committed": (() => ({ ok: true })) as never,
      "google:env-credentials": (() => ({ found: false })) as never,
      "google:validate-credentials": (() => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        credentialType: "service_account",
        credentialsPath: "/tmp/adc.json",
        projects: [
          { projectId: "proj-one", displayName: "Project One" },
          { projectId: "proj-two", displayName: "Project Two" },
        ],
      })) as never,
      "google:set-project": (() => ({ ok: true, projectName: "Project Two" })) as never,
      "google:check-project": (() => ({ enabled: true })) as never,
    })
    fireEvent.change(await screen.findByLabelText("Service account key JSON"), {
      target: { value: SA_KEY },
    })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))
    await screen.findByText("Select a Google Cloud project to continue:")

    const detail = await askAgent(api, { op: "get_block", blockId: "gcp" })
    expect(detail.state.projects).toEqual([
      { id: "proj-one", name: "Project One" },
      { id: "proj-two", name: "Project Two" },
    ])
    await askAgent(api, {
      op: "act_on_block",
      blockId: "gcp",
      action: "select_project",
      params: { project_id: "proj-two" },
    })
    await vi.waitFor(() =>
      expect(api.callsTo("google:set-project")[0]).toMatchObject({ projectId: "proj-two" }),
    )
    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
  })
})
