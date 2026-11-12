import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect } from "react"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext, flattenInputs } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import YAML from "yaml"
import type { TfModuleSpec } from "../../../../../../src/domain/tf-module/types"
import { parseDeclarations } from "../../../../../../src/domain/lookups/parse"
import { mergeDeclarations } from "../../../../../../src/domain/lookups/validate"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import TfModule from "../TfModule"
import { useRequestedScopes } from "@/contexts/ScopeRequests"

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({ activeWorkTree: null, workTrees: [] }),
}))

const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1"
const SCOPE = "https://www.googleapis.com/auth/admin.directory.domain.readonly"

const definitions = mergeDeclarations(
  parseDeclarations(
    YAML.parse(`
lookups:
  google:
    auth: GoogleAuth
    scopes: [${SCOPE}]
    domains:
      request: { url: "${DIRECTORY}/customer/my_customer/domains" }
      rows: domains
      fields: { value: domainName }
    customer:
      request: { url: "${DIRECTORY}/customers/my_customer" }
      fields: { value: id }
    people:
      request: { url: "${DIRECTORY}/users?customer=my_customer&query={{ .query }}" }
      rows: users
      fields: { value: primaryEmail, label: name.fullName }
`),
    "runbook_block.yml",
  ),
  [],
).definitions

const spec: TfModuleSpec = {
  title: "Google group",
  description: "A Google Workspace group.",
  providers: [{ name: "google" }],
  outputs: [{ name: "group_email", label: "Group email", description: "", sensitive: false }],
  definitions,
  preflight: [],
  authGroups: ["google"],
  warnings: [],
  variables: [
    {
      name: "domain",
      label: "Domain",
      description: "",
      tfType: "string",
      kind: "string",
      hasDefault: false,
      sensitive: false,
      primary: true,
      lookup: { from: "google.domains", with: {} },
    },
    {
      name: "group_name",
      label: "Group name",
      description: "The group's local part.",
      tfType: "string",
      kind: "string",
      hasDefault: false,
      sensitive: false,
      primary: true,
      suffix: "@{{ .domain }}",
      checks: [
        { kind: "regex", pattern: "^[a-z0-9-]+@[a-z.]+$", message: "Use lowercase letters." },
      ],
    },
    {
      name: "display_name",
      label: "Display name",
      description: "",
      tfType: "string",
      kind: "string",
      hasDefault: true,
      default: "",
      sensitive: false,
      primary: true,
    },
    {
      name: "allow_external",
      label: "Allow external members",
      description: "Let people outside the domain join.",
      tfType: "bool",
      kind: "bool",
      hasDefault: true,
      default: false,
      sensitive: false,
      primary: false,
    },
  ],
}

const DOMAINS = [{ domainName: "example.com" }, { domainName: "example.org" }]
let domainRows: unknown[] = DOMAINS
const GENERATED = {
  code: {
    kind: "repo",
    tool: "terragrunt",
    folder: "groups/platform",
    files: [{ path: "groups/platform/terragrunt.hcl", content: "", status: "added" }],
    rootHcl: true,
  },
  written: ["groups/platform/terragrunt.hcl"],
  fingerprints: { "groups/platform/terragrunt.hcl": "abc123" },
  kept: [] as string[],
}
let generated = GENERATED
let generateError: Error | null = null

const json = (body: unknown) =>
  Promise.resolve({ status: 200, contentType: "application/json", body: JSON.stringify(body) })

const invoke = vi.fn((channel: string, params?: { request?: { url: string } }) => {
  if (channel === "google:send") {
    const url = params?.request?.url ?? ""
    if (url.endsWith("/customers/my_customer")) return json({ id: "C01abc23d" })
    if (url.includes("/users?")) {
      return json({ users: [{ primaryEmail: "ana@example.com", name: { fullName: "Ana Lima" } }] })
    }
    return json({ domains: domainRows })
  }
  if (channel === "tf-module:generate") {
    return generateError ? Promise.reject(generateError) : Promise.resolve(generated)
  }
  return Promise.reject(new Error(`unexpected channel ${channel}`))
})

let moduleSpec = spec
let readError: { message: string } | null = null
const refetch = vi.fn()
vi.mock("@/hooks/useIpc", () => ({
  useIpc: () => ({ data: moduleSpec, isLoading: false, error: readError, refetch }),
}))

// One object, as the app's provider gives, so hooks that depend on it don't ask again each render.
const api = { invoke }
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

function renderBlock(
  auth: Record<string, string> = { google: "workspace" },
  prefilledVariables?: Record<string, unknown>,
) {
  return render(
    <TestWrapper>
      <Capture />
      <FakeGoogleAuth id="workspace" scopes={[SCOPE]} />
      <TfModule
        id="group"
        source="google-group"
        template="templates/google-group-unit"
        auth={auth}
        {...(prefilledVariables ? { prefilledVariables } : {})}
      />
    </TestWrapper>,
  )
}

const signIn = () =>
  act(() =>
    ctx!.registerOutputs("workspace", {
      GOOGLE_AUTH_TYPE: "oauth",
      CLOUDSDK_CORE_ACCOUNT: "ana@example.com",
      GOOGLE_CLOUD_PROJECT: "acme-ops",
    }),
  )

const sentUrls = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === "google:send")
    .map(([, params]) => params?.request?.url)

/** Renders the block with the workspace block signed in. */
async function renderSignedIn() {
  const view = renderBlock()
  await waitFor(() => expect(ctx).toBeDefined())
  signIn()
  return view
}

const input = (name: string) => document.getElementById(`group-${name}`) as HTMLInputElement

describe("TfModule", () => {
  beforeEach(() => {
    generated = GENERATED
    generateError = null
    domainRows = DOMAINS
    moduleSpec = spec
    readError = null
    refetch.mockClear()
    ctx = undefined
    invoke.mockClear()
  })

  it("shows the primary inputs and keeps the rest under Advanced options", () => {
    renderBlock()
    expect(screen.getByText("Google group", { selector: "div" })).toBeInTheDocument()
    const ui = within(screen.getByTestId("group"))
    expect(ui.getByLabelText(/Group name/)).toBeInTheDocument()
    expect(ui.queryByText("Allow external members")).not.toBeInTheDocument()

    fireEvent.click(ui.getByRole("button", { name: /Advanced options/ }))
    expect(ui.getByText("Allow external members")).toBeInTheDocument()
  })

  it("links to the module on GitHub in place of its source, and shows no link without a page", () => {
    moduleSpec = {
      ...spec,
      page: "https://github.com/acme/catalog/tree/v1.4.0/modules/google-group",
    }
    const { unmount } = renderBlock()
    expect(screen.getByRole("link", { name: /View the OpenTofu module/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/catalog/tree/v1.4.0/modules/google-group",
    )
    expect(screen.queryByText("google-group")).not.toBeInTheDocument()
    unmount()

    moduleSpec = spec
    renderBlock()
    expect(screen.queryByRole("link", { name: /View the OpenTofu module/ })).not.toBeInTheDocument()
  })

  it("flags required inputs and failed checks on Generate, and doesn't generate", () => {
    renderBlock()
    fireEvent.change(input("group_name"), { target: { value: "Not Valid" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    expect(screen.getByText("Choose Domain first.")).toBeInTheDocument()
    expect(screen.getByText("Required.")).toBeInTheDocument()
    expect(screen.getByText("2 inputs above need a fix.")).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith("tf-module:generate", expect.anything())
  })

  it("fills an input from a lookup pick, then generates the code and says where it went", async () => {
    await renderSignedIn()
    fireEvent.change(input("group_name"), { target: { value: "platform" } })
    fireEvent.change(input("display_name"), { target: { value: "Team at example.com" } })

    const domain = input("domain")
    fireEvent.change(domain, { target: { value: "example.c" } })
    const option = await screen.findByRole("option", { name: /example\.com/ })
    // The lookup doesn't send what's typed, so the form filters its rows.
    expect(screen.queryByRole("option", { name: /example\.org/ })).not.toBeInTheDocument()
    fireEvent.mouseDown(option)

    expect(domain).toHaveValue("example.com")
    expect(invoke).toHaveBeenCalledWith("google:send", {
      blockId: "workspace",
      request: expect.objectContaining({ url: `${DIRECTORY}/customer/my_customer/domains` }),
    })

    expect(screen.getByTestId("group-group_name-suffix")).toHaveTextContent("@example.com")

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    const values = {
      group_name: "platform@example.com",
      domain: "example.com",
      display_name: "Team at example.com",
      allow_external: false,
    }
    await waitFor(() => expect(flattenInputs(ctx!.getInputs("group"))).toEqual(values))
    expect(await screen.findByText("groups/platform/terragrunt.hcl")).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(
      "tf-module:generate",
      expect.objectContaining({
        blockId: "group",
        template: "templates/google-group-unit",
        values,
      }),
    )
    await waitFor(() =>
      expect(ctx!.getOutputs("group")).toEqual(
        expect.arrayContaining([
          { name: "MODULE_SOURCE", value: "google-group" },
          { name: "TEMPLATE", value: "templates/google-group-unit" },
          { name: "CODE_PATH", value: "groups/platform" },
        ]),
      ),
    )
    expect(screen.queryByRole("button", { name: "Generate" })).not.toBeInTheDocument()
  })

  it("writes the code again as the inputs change, in place of what it wrote", async () => {
    renderBlock()
    fireEvent.change(input("domain"), { target: { value: "example.com" } })
    fireEvent.change(input("group_name"), { target: { value: "platform" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    await screen.findByText("groups/platform/terragrunt.hcl")

    fireEvent.change(input("display_name"), { target: { value: "Platform" } })
    await waitFor(
      () =>
        expect(invoke).toHaveBeenCalledWith(
          "tf-module:generate",
          expect.objectContaining({
            values: expect.objectContaining({ display_name: "Platform" }),
            replaces: { "groups/platform/terragrunt.hcl": "abc123" },
          }),
        ),
      { timeout: 2000 },
    )
  })

  it("tries a failed generate again with the same inputs", async () => {
    generateError = new Error("The module couldn't be cloned: the network is down.")
    renderBlock()
    fireEvent.change(input("domain"), { target: { value: "example.com" } })
    fireEvent.change(input("group_name"), { target: { value: "platform" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(await screen.findByText(/the network is down/)).toBeInTheDocument()

    generateError = null
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByText("groups/platform/terragrunt.hcl")).toBeInTheDocument()
    const generates = invoke.mock.calls.filter(([channel]) => channel === "tf-module:generate")
    expect(generates).toHaveLength(2)
    expect(generates[1]?.[1]).toEqual(generates[0]?.[1])
  })

  it("lists files it kept because they changed after it wrote them", async () => {
    generated = { ...GENERATED, kept: ["groups/old/terragrunt.hcl"] }
    renderBlock()
    fireEvent.change(input("domain"), { target: { value: "example.com" } })
    fireEvent.change(input("group_name"), { target: { value: "platform" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(await screen.findByText("groups/old/terragrunt.hcl")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(/changed after the block wrote it/)
  })

  it("keeps the last valid inputs published while one needs a fix", async () => {
    renderBlock()
    fireEvent.change(input("domain"), { target: { value: "example.com" } })
    fireEvent.change(input("group_name"), { target: { value: "platform" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    await screen.findByText("groups/platform/terragrunt.hcl")

    fireEvent.change(input("group_name"), { target: { value: "Not Valid" } })
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 700)
      })
    })
    expect(flattenInputs(ctx!.getInputs("group")).group_name).toBe("platform@example.com")
    expect(invoke.mock.calls.filter(([channel]) => channel === "tf-module:generate")).toHaveLength(
      1,
    )
  })

  it("shows the email's domain once an organization is chosen, and asks for one first", () => {
    renderBlock()
    expect(screen.getByTestId("group-group_name-suffix")).toHaveTextContent("@‹Domain›")
    fireEvent.change(input("group_name"), { target: { value: "platform" } })
    fireEvent.blur(input("group_name"))
    expect(screen.getByText("Choose Domain first.")).toBeInTheDocument()
  })

  it("starts an input with a prefilled value in place of the module's default", async () => {
    renderBlock(undefined, { display_name: "Platform team", allow_external: true })
    await waitFor(() => expect(input("display_name").value).toBe("Platform team"))
    fireEvent.click(screen.getByRole("button", { name: /Advanced options/ }))
    expect(input("allow_external")).toBeChecked()
  })

  it("fills an input from another block's output once it exists, and once per value", async () => {
    renderBlock(undefined, { display_name: "Mail to {{ .outputs.apply_group.email }}" })
    await waitFor(() => expect(ctx).toBeDefined())
    expect(input("display_name").value).toBe("")

    act(() => ctx!.registerOutputs("apply-group", { email: "aws-dev@example.com" }))
    await waitFor(() => expect(input("display_name").value).toBe("Mail to aws-dev@example.com"))

    // Cleared, it stays clear while the output keeps its value.
    fireEvent.change(input("display_name"), { target: { value: "" } })
    act(() => ctx!.registerOutputs("apply-group", { email: "aws-dev@example.com" }))
    expect(input("display_name").value).toBe("")

    // A new value fills it again, but never over what the user typed.
    act(() => ctx!.registerOutputs("apply-group", { email: "aws-prod@example.com" }))
    await waitFor(() => expect(input("display_name").value).toBe("Mail to aws-prod@example.com"))
    fireEvent.change(input("display_name"), { target: { value: "Ops" } })
    act(() => ctx!.registerOutputs("apply-group", { email: "aws-stage@example.com" }))
    expect(input("display_name").value).toBe("Ops")
  })

  it("follows its output while the input holds what it filled, and reads text as the input's kind", async () => {
    renderBlock(undefined, {
      display_name: "{{ .outputs.apply_group.email }}",
      allow_external: "{{ .outputs.apply_group.external }}",
    })
    await waitFor(() => expect(ctx).toBeDefined())
    act(() =>
      ctx!.registerOutputs("apply-group", { email: "aws-dev@example.com", external: "false" }),
    )
    await waitFor(() => expect(input("display_name").value).toBe("aws-dev@example.com"))
    fireEvent.click(screen.getByRole("button", { name: /Advanced options/ }))
    expect(input("allow_external")).not.toBeChecked()

    act(() =>
      ctx!.registerOutputs("apply-group", { email: "aws-prod@example.com", external: "true" }),
    )
    await waitFor(() => expect(input("display_name").value).toBe("aws-prod@example.com"))
    expect(input("allow_external")).toBeChecked()

    act(() =>
      ctx!.registerOutputs("apply-group", { email: "aws-prod@example.com", external: "yes" }),
    )
    expect(
      await screen.findByText(
        'prefilledVariables.allow_external is "yes", which isn\'t true or false.',
      ),
    ).toBeInTheDocument()
    expect(input("allow_external")).toBeChecked()
  })

  it("refuses prefilled values for inputs the module doesn't have", () => {
    renderBlock(undefined, { display_nme: "Platform team" })
    expect(screen.getByText(/names inputs the module doesn't have/)).toBeInTheDocument()
    expect(screen.getByText(/Unknown: display_nme\./)).toBeInTheDocument()
  })

  it("opens suggestions on typing or Enter, not on focus", async () => {
    await renderSignedIn()
    const domain = input("domain")
    fireEvent.focus(domain)
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    expect(sentUrls()).toEqual([])

    fireEvent.keyDown(domain, { key: "Enter" })
    expect(await screen.findByRole("option", { name: /example\.org/ })).toBeInTheDocument()
    expect(sentUrls()).toEqual([`${DIRECTORY}/customer/my_customer/domains`])
  })

  it("sends what's typed to a lookup that asks the API with it", async () => {
    moduleSpec = {
      ...spec,
      variables: spec.variables.map((v) =>
        v.name === "display_name" ? { ...v, lookup: { from: "google.people", with: {} } } : v,
      ),
    }
    await renderSignedIn()
    fireEvent.change(input("display_name"), { target: { value: "ana l" } })
    expect(await screen.findByRole("option", { name: /Ana Lima/ })).toBeInTheDocument()
    expect(sentUrls()).toContain(`${DIRECTORY}/users?customer=my_customer&query=ana%20l`)
  })

  it("says when a lookup finds nothing, rather than showing no list", async () => {
    domainRows = []
    await renderSignedIn()
    fireEvent.change(input("domain"), { target: { value: "nowhere" } })
    expect(await screen.findByText('Nothing matches "nowhere".')).toBeInTheDocument()
    expect(
      screen.getByText("You can still type the whole value and press Enter."),
    ).toBeInTheDocument()
  })

  it("asks for a sign-in to the bound block, then asks the lookup again once there is one", async () => {
    renderBlock()
    fireEvent.keyDown(input("domain"), { key: "Enter" })
    expect(
      await screen.findByText("Sign in with the workspace block above for suggestions here."),
    ).toBeInTheDocument()
    expect(sentUrls()).toEqual([])

    signIn()
    expect(await screen.findByRole("option", { name: /example\.org/ })).toBeInTheDocument()
    expect(sentUrls()).toHaveLength(1)
  })

  it("asks the bound auth block for the scopes its lookup groups declare", async () => {
    function Probe() {
      return <output data-testid="requested">{useRequestedScopes("workspace").join(" ")}</output>
    }
    render(
      <TestWrapper>
        <Probe />
        <FakeGoogleAuth id="workspace" scopes={[SCOPE]} />
        <TfModule
          id="group"
          source="google-group"
          template="templates/google-group-unit"
          auth={{ google: "workspace" }}
        />
      </TestWrapper>,
    )
    await waitFor(() => expect(screen.getByTestId("requested")).toHaveTextContent(SCOPE))
  })

  it("refuses an auth prop that leaves a group the module uses unbound", async () => {
    renderBlock({})
    expect(
      await screen.findByText(/The <TfModule> block's auth prop doesn't fit the module's lookups/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/need the google group bound to a GoogleAuth block/),
    ).toBeInTheDocument()
  })

  it("accepts a bound block that doesn't list its group's scopes, since it's asked for them", async () => {
    render(
      <TestWrapper>
        <FakeGoogleAuth id="workspace" scopes={["openid"]} />
        <TfModule
          id="group"
          source="google-group"
          template="templates/google-group-unit"
          auth={{ google: "workspace" }}
        />
      </TestWrapper>,
    )
    await waitFor(() => expect(input("domain")).not.toBeNull())
    expect(screen.queryByText(/auth prop doesn't fit/)).toBeNull()
  })
  describe("with a prefill", () => {
    const customerId = {
      name: "customer_id",
      label: "Customer ID",
      description: "",
      tfType: "string",
      kind: "string",
      hasDefault: true,
      default: "",
      sensitive: false,
      primary: false,
      prefill: { from: "google.customer", with: {} },
    } as const

    it("fills the empty input from the lookup, even under Advanced options", async () => {
      moduleSpec = { ...spec, variables: [...spec.variables, customerId] }
      await renderSignedIn()
      await waitFor(() => expect(sentUrls()).toContain(`${DIRECTORY}/customers/my_customer`))
      fireEvent.click(screen.getByRole("button", { name: /Advanced options/ }))
      await waitFor(() => expect(input("customer_id").value).toBe("C01abc23d"))
    })

    it("leaves an input the user cleared empty", async () => {
      moduleSpec = { ...spec, variables: [...spec.variables, customerId] }
      await renderSignedIn()
      fireEvent.click(screen.getByRole("button", { name: /Advanced options/ }))
      await waitFor(() => expect(input("customer_id").value).toBe("C01abc23d"))

      fireEvent.change(input("customer_id"), { target: { value: "" } })
      signIn()
      const customerCalls = () =>
        sentUrls().filter((url) => url === `${DIRECTORY}/customers/my_customer`)
      await waitFor(() => expect(customerCalls()).toHaveLength(2))
      expect(input("customer_id").value).toBe("")
    })
  })
  it("reads a module it couldn't clone again once someone signs in to GitHub", async () => {
    readError = { message: "Couldn't clone acme/catalog: sign in to GitHub." }
    renderBlock()
    expect(screen.getByText(/sign in to GitHub/)).toBeInTheDocument()
    await waitFor(() => expect(ctx).toBeDefined())
    refetch.mockClear()

    act(() => ctx!.registerOutputs("github-auth", { GIT_PROVIDER: "github" }))
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
  })
})
