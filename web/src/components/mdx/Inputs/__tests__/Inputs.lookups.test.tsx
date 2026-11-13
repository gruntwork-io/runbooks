import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import YAML from "yaml"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import { parseDeclarations } from "../../../../../../src/domain/lookups/parse"
import { mergeDeclarations } from "../../../../../../src/domain/lookups/validate"
import Inputs from "../Inputs"

// The real block and form with the real lookup engine. The mock boundaries
// are the config main reads from boilerplate.yml and the preload API that
// sends the lookups' requests.

const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1"
const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly"

const definitions = mergeDeclarations(
  parseDeclarations(
    YAML.parse(`
x-lookups:
  google:
    auth: GoogleAuth
    scopes: [${SCOPE}]
    me:
      request: { url: "${DIRECTORY}/users/{{ .auth.email }}" }
      fields: { value: primaryEmail, label: name.fullName }
    people:
      request: { url: "${DIRECTORY}/users?query={{ .query }}" }
      rows: users
      fields: { value: primaryEmail, label: name.fullName }
`),
    "boilerplate.yml",
    "x-",
  ),
  [],
).definitions

const withLookups = (problems: string[] = []): BoilerplateConfig => ({
  variables: [
    { name: "owner", type: "string", description: "Owner" },
    { name: "reviewers", type: "list", description: "Reviewers" },
  ],
  outputDependencies: [],
  lookups: {
    definitions,
    inputs: {
      owner: { prefill: { from: "google.me", with: {} } },
      reviewers: {
        lookup: { from: "google.people", with: {} },
        shortcut: { from: "google.me", with: {}, label: 'Add "{{ .label }}"' },
      },
    },
    groups: ["google"],
    problems,
  },
})

let config = withLookups()
vi.mock("@/hooks/useApiGetBoilerplateConfig", () => ({
  useApiGetBoilerplateConfig: () => ({
    data: config,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    silentRefetch: vi.fn(),
  }),
}))

const json = (body: unknown) =>
  Promise.resolve({ status: 200, contentType: "application/json", body: JSON.stringify(body) })

const invoke = vi.fn((channel: string, params?: { request?: { url: string } }) => {
  if (channel === "google:send") {
    const url = params?.request?.url ?? ""
    if (url.includes("/users?")) {
      return json({ users: [{ primaryEmail: "bo@example.com", name: { fullName: "Bo Chen" } }] })
    }
    return json({ primaryEmail: "ana@example.com", name: { fullName: "Ana Lima" } })
  }
  return Promise.resolve(undefined)
})
const api = { invoke, on: () => () => {} }
vi.mock("@/contexts/ApiContext", () => ({ useApi: () => api }))
vi.mock("@/contexts/useLogs", () => ({ useLogs: () => ({ registerLogs: vi.fn() }) }))

let ctx: RunbookContextType | undefined
function Capture() {
  const runbook = useRunbookContext()
  useEffect(() => {
    ctx = runbook
  }, [runbook])
  return null
}

/** Stands in for a <GoogleAuth> block on the page, which registers its id, kind and scopes. */
function FakeGoogleAuth({ id, scopes }: { id: string; scopes: readonly string[] }) {
  useComponentIdRegistry(id, "GoogleAuth", undefined, scopes)
  return null
}

function renderInputs(auth?: Record<string, string>, scopes: readonly string[] = [SCOPE]) {
  return render(
    <TestWrapper>
      <Capture />
      <FakeGoogleAuth id="workspace" scopes={scopes} />
      <Inputs id="team" path="boilerplate.yml" {...(auth ? { auth } : {})} />
    </TestWrapper>,
  )
}

const signIn = async () => {
  await waitFor(() => expect(ctx).toBeDefined())
  act(() =>
    ctx!.registerOutputs("workspace", {
      GOOGLE_AUTH_TYPE: "oauth",
      CLOUDSDK_CORE_ACCOUNT: "ana@example.com",
      GOOGLE_CLOUD_PROJECT: "acme-ops",
    }),
  )
}

describe("Inputs lookups", () => {
  beforeEach(() => {
    config = withLookups()
    ctx = undefined
    invoke.mockClear()
  })

  it("shows the boilerplate.yml's lookup problems in place of the form", () => {
    config = withLookups(["boilerplate.yml: variables.owner.x-lookup uses google.nobody"])
    renderInputs({ google: "workspace" })
    expect(screen.getByText(/declares lookups it can't use/)).toBeInTheDocument()
    expect(screen.getByText(/google\.nobody/)).toBeInTheDocument()
  })

  it("needs the lookups' group bound to an auth block", async () => {
    renderInputs()
    expect(await screen.findByText(/auth prop doesn't fit/)).toBeInTheDocument()
    expect(
      screen.getByText(/need the google group bound to a GoogleAuth block/),
    ).toBeInTheDocument()
  })

  it("accepts a bound block that doesn't list the group's scopes, since it's asked for them", async () => {
    renderInputs({ google: "workspace" }, ["openid"])
    expect(await screen.findByLabelText("Owner")).toBeInTheDocument()
    expect(screen.queryByText(/auth prop doesn't fit/)).toBeNull()
  })

  it("prefills, suggests and offers a shortcut once signed in", async () => {
    renderInputs({ google: "workspace" })
    await signIn()

    // x-prefill fills the empty owner with the signed-in person.
    await waitFor(() => expect(screen.getByLabelText("Owner")).toHaveValue("ana@example.com"))

    // x-shortcut offers the one row, and adds it.
    fireEvent.click(await screen.findByRole("button", { name: 'Add "Ana Lima"' }))
    expect(await screen.findByText("ana@example.com", { selector: "span" })).toBeInTheDocument()

    // x-lookup suggests as you type.
    const reviewers = screen.getByRole("combobox", { name: "Reviewers" })
    fireEvent.change(reviewers, { target: { value: "bo" } })
    expect(await screen.findByRole("option", { name: /Bo Chen/ })).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith("google:send", {
      blockId: "workspace",
      request: expect.objectContaining({ url: `${DIRECTORY}/users?query=bo` }),
    })
  })
})
