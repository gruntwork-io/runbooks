import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { ComponentProps, ReactNode } from "react"
import { BoilerplateInputsForm } from "../BoilerplateInputsForm"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import { BoilerplateValidationType, type BoilerplateVariable } from "@/types/boilerplateVariable"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import { RunbookProgressProbe, RunbookStateStub } from "@/test/test-utils"
import { RunbookProgressProvider } from "@/contexts/RunbookProgressContext"
import { ComponentIdRegistryProvider, useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { ErrorReportingProvider } from "@/contexts/ErrorReportingContext"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import type { ReportedError } from "@/contexts/ErrorReportingContext.types"
import { sensitiveOutput } from "@/lib/outputValues"

const config: BoilerplateConfig = {
  variables: [{ name: "region", type: "string", description: "", default: "us-east-1" }],
}

function renderForm(props: Partial<ComponentProps<typeof BoilerplateInputsForm>> = {}) {
  const onGenerate = vi.fn()
  const element = (overrides: Partial<ComponentProps<typeof BoilerplateInputsForm>> = {}) => (
    <BoilerplateInputsForm
      id="tpl"
      blockType="Template"
      boilerplateConfig={config}
      onGenerate={onGenerate}
      enableAutoRender={false}
      variant="standard"
      {...props}
      {...overrides}
    />
  )
  const utils = render(element())
  const block = () => utils.container.querySelector(".runbook-block") as HTMLElement
  return {
    ...utils,
    onGenerate,
    block,
    rerenderWith: (o: Partial<ComponentProps<typeof BoilerplateInputsForm>>) =>
      utils.rerender(element(o)),
  }
}

// Success is controlled by the parent: clicking Generate only requests a
// render, which may still fail.
describe("BoilerplateInputsForm success state", () => {
  it("stays neutral and keeps the Generate button until the parent reports success", () => {
    const { onGenerate, block, rerenderWith } = renderForm({ hasGeneratedSuccessfully: false })

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).toHaveBeenCalledWith({ region: "us-east-1" })
    expect(block().className).not.toContain("bg-success-muted")
    expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument()
    expect(screen.queryByText("Up to date")).toBeNull()

    rerenderWith({ hasGeneratedSuccessfully: true })
    expect(block().className).toContain("bg-success-muted")
    expect(screen.getByText("Up to date")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull()
  })

  it("drops the success styling and reports the failure when a later render fails", () => {
    const { block } = renderForm({ hasGeneratedSuccessfully: true, hasRenderError: true })

    expect(block().className).not.toContain("bg-success-muted")
    expect(screen.queryByText("Up to date")).toBeNull()
    expect(screen.getByText(/Generation failed/)).toBeInTheDocument()
  })
})

// A form with its own Generate or Submit button is a step of the runbook. An
// embedded one is part of the block it's in, which counts for itself.
describe("BoilerplateInputsForm progress", () => {
  function ProgressPage({ children }: { children: ReactNode }) {
    return (
      <RunbookProgressProvider>
        {children}
        <RunbookProgressProbe />
      </RunbookProgressProvider>
    )
  }

  function form(props: Partial<ComponentProps<typeof BoilerplateInputsForm>> = {}) {
    return (
      <BoilerplateInputsForm
        id="tpl"
        blockType="Template"
        boilerplateConfig={config}
        onGenerate={vi.fn()}
        enableAutoRender={false}
        variant="standard"
        {...props}
      />
    )
  }

  it("is a step, done while it shows its success styling", () => {
    const { rerender } = render(form({ hasGeneratedSuccessfully: false }), {
      wrapper: ProgressPage,
    })
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")

    rerender(form({ hasGeneratedSuccessfully: true }))
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("1/1")

    rerender(form({ hasGeneratedSuccessfully: true, hasRenderError: true }))
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")
  })

  it.each([
    { name: "an embedded form", props: { variant: "embedded" as const } },
    { name: "a form without its own button", props: { showSubmitButton: false } },
  ])("isn't a step for $name", ({ props }) => {
    render(form({ hasGeneratedSuccessfully: true, ...props }), { wrapper: ProgressPage })
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/0")
  })
})

// A required tuple starts from the elements its controls display, and is only
// "required" while those still read as blank.
describe("BoilerplateInputsForm required tuples", () => {
  const tupleConfig = (schema: Record<string, string>): BoilerplateConfig => ({
    variables: [
      {
        name: "Pair",
        type: "list",
        description: "",
        schema,
        required: true,
        validations: [{ type: BoilerplateValidationType.Required }],
      },
    ],
  })

  it("generates an untouched tuple of bools with the false both selects show", () => {
    const { onGenerate } = renderForm({
      boilerplateConfig: tupleConfig({ "0": "bool", "1": "bool" }),
    })

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    expect(screen.queryByText(/is required/)).toBeNull()
    expect(onGenerate).toHaveBeenCalledWith({ Pair: [false, false] })
  })

  it("reports a tuple whose string element is blank as required, next to a bool showing false", () => {
    const { onGenerate } = renderForm({
      boilerplateConfig: tupleConfig({ "0": "string", "1": "bool" }),
    })

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    expect(screen.getAllByText(/is required/).length).toBeGreaterThan(0)
    expect(onGenerate).not.toHaveBeenCalled()
  })
})

// Defaults that reference other variables are shown as linked tokens, but the
// raw expressions are what the form sends: main resolves them when rendering,
// so an untouched form renders exactly as it did when they were shown as text.
describe("BoilerplateInputsForm template-valued defaults", () => {
  const linkedConfig: BoilerplateConfig = {
    variables: [
      { name: "Base", type: "string", description: "", default: "app" },
      { name: "BucketName", type: "string", description: "", default: "{{ .Base }}-state" },
      {
        name: "Repos",
        type: "list",
        description: "",
        default: ["github.com/acme/catalog", "{{ .Base }}/modules"],
      },
      { name: "Tags", type: "map", description: "", default: { "{{ .Base }}:Team": "DevOps" } },
    ],
  }

  it("sends the untouched expressions unchanged without ever showing {{ }} syntax", () => {
    const { container, onGenerate } = renderForm({ boilerplateConfig: linkedConfig })

    expect(container.textContent).not.toContain("{{")
    for (const input of Array.from(container.querySelectorAll("input, select"))) {
      expect((input as HTMLInputElement).value).not.toContain("{{")
    }
    // The field's label still points at it
    expect(screen.getByLabelText("Bucket Name")).toHaveTextContent("Base-state")

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).toHaveBeenCalledWith({
      Base: "app",
      BucketName: "{{ .Base }}-state",
      Repos: ["github.com/acme/catalog", "{{ .Base }}/modules"],
      Tags: { "{{ .Base }}:Team": "DevOps" },
    })
  })

  it("sends an empty value once the link is cleared", () => {
    const { onGenerate } = renderForm({ boilerplateConfig: linkedConfig })

    fireEvent.click(screen.getByRole("button", { name: "Clear linked value" }))
    expect((screen.getByLabelText("Bucket Name") as HTMLInputElement).value).toBe("")

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({ BucketName: "" }))
  })
})

// A locked field (x-locked) takes its value from the runbook: the form shows it
// but nobody can change it. A hidden one (x-hidden) isn't shown at all.
describe("BoilerplateInputsForm locked and hidden fields", () => {
  const required = [{ type: BoilerplateValidationType.Required }]
  const curatedConfig: BoilerplateConfig = {
    variables: [
      { name: "Region", type: "string", description: "", default: "us-east-1" },
      {
        name: "Provider",
        type: "enum",
        description: "",
        options: ["github", "gitlab"],
        default: "github",
        locked: true,
      },
      { name: "Tags", type: "map", description: "", default: { Team: "DevOps" }, locked: true },
      {
        name: "RepoOwner",
        type: "string",
        description: "",
        default: "acme",
        locked: true,
        hidden: true,
      },
    ],
  }

  it("shows a locked field read-only, without asking for it", () => {
    renderForm({
      boilerplateConfig: {
        variables: [
          { ...curatedConfig.variables[1]!, required: true, validations: required },
          curatedConfig.variables[2]!,
        ],
      },
    })

    const provider = screen.getByTestId("field-Provider")
    expect(provider).toHaveTextContent("(locked)")
    expect(provider).not.toHaveTextContent("*")
    expect(provider.querySelector("select")).toBeDisabled()
    // A list or map says why it can't be changed in its header too
    expect(screen.getByTestId("field-Tags")).toHaveTextContent("1 entry(locked)")
    expect(screen.queryByPlaceholderText("Key")).toBeNull()
  })

  it("sends the runbook's values for locked and hidden fields", () => {
    const { onGenerate } = renderForm({ boilerplateConfig: curatedConfig })

    expect(screen.queryByTestId("field-RepoOwner")).toBeNull()
    expect(screen.queryByText("Repo Owner")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).toHaveBeenCalledWith({
      Region: "us-east-1",
      Provider: "github",
      Tags: { Team: "DevOps" },
      RepoOwner: "acme",
    })
  })

  it("shows a hidden field, locked, when it has an error, so the form never fails on something unseen", () => {
    const { onGenerate } = renderForm({
      boilerplateConfig: {
        variables: [
          curatedConfig.variables[0]!,
          {
            name: "RepoOwner",
            type: "string",
            description: "",
            required: true,
            validations: required,
            locked: true,
            hidden: true,
          },
        ],
      },
    })
    expect(screen.queryByTestId("field-RepoOwner")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    expect(onGenerate).not.toHaveBeenCalled()
    const owner = screen.getByTestId("field-RepoOwner")
    expect(owner).toHaveTextContent("(locked)")
    expect(owner).toHaveTextContent("Repo Owner is required")
    expect(owner.querySelector("input")).toBeDisabled()
    expect(screen.getByText(/There is/)).toHaveTextContent("There is 1 validation error above")
  })

  it("shows a field the block imports as inherited, even when the template locks it", () => {
    renderForm({
      boilerplateConfig: curatedConfig,
      sharedVarNames: new Set(["Provider"]),
      liveVarValues: { Provider: "gitlab" },
    })

    expect(screen.getByTestId("field-Provider")).toHaveTextContent("(inherited)")
    expect(screen.getByTestId("field-Provider")).not.toHaveTextContent("(locked)")
  })
})

// x-sections can fold a section (collapsed: true): it starts closed, with its
// fields' values still in the form.
describe("BoilerplateInputsForm collapsed sections", () => {
  const sectionedConfig = (owner: Partial<BoilerplateVariable> = {}): BoilerplateConfig => ({
    variables: [
      { name: "Name", type: "string", description: "", default: "app" },
      { name: "Memory", type: "string", description: "", default: "128", sectionName: "Advanced" },
      {
        name: "Owner",
        type: "string",
        description: "",
        default: "ops",
        sectionName: "Advanced",
        ...owner,
      },
      {
        name: "Secret",
        type: "string",
        description: "",
        default: "x",
        sectionName: "Internal",
        locked: true,
        hidden: true,
      },
    ],
    sections: [
      { name: "", variables: ["Name"] },
      { name: "Advanced", variables: ["Memory", "Owner"], collapsed: true },
      { name: "Internal", variables: ["Secret"] },
    ],
  })
  const toggle = () => screen.getByRole("button", { name: "Advanced" })

  it("starts folded and opens and closes from its heading, keeping its values", () => {
    const { onGenerate } = renderForm({ boilerplateConfig: sectionedConfig() })

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("field-Memory")).toBeNull()

    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "256" } })

    fireEvent.click(toggle())
    expect(screen.queryByTestId("field-Memory")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).toHaveBeenCalledWith({
      Name: "app",
      Memory: "256",
      Owner: "ops",
      Secret: "x",
    })
  })

  it("opens to show an error in it, and stays open once it's fixed", () => {
    renderForm({
      boilerplateConfig: sectionedConfig({
        default: undefined,
        required: true,
        validations: [{ type: BoilerplateValidationType.Required }],
      }),
    })

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("field-Owner")).toHaveTextContent("Owner is required")

    fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: "platform" } })
    expect(screen.queryByText("Owner is required")).toBeNull()
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
  })

  it("leaves out a section whose fields are all hidden", () => {
    renderForm({ boilerplateConfig: sectionedConfig() })

    expect(screen.queryByText("Internal")).toBeNull()
  })
})

// The form asks main what each linked value comes to (boilerplate:resolve-inputs)
// and shows that in place of the tokens. Main resolves the way a render does;
// this stand-in substitutes `{{ .Name }}` and `{{ .outputs.block.name }}`, and
// leaves a value whose reference is missing as it was, as main does.
describe("BoilerplateInputsForm resolved linked values", () => {
  type ResolveRequest = {
    inputs: Record<string, unknown>
    outputs: Record<string, Record<string, string>>
  }

  function fakeResolve({ inputs, outputs }: ResolveRequest): Record<string, unknown> {
    const resolveString = (text: string): string => {
      let missing = false
      const out = text.replace(/\{\{\s*\.([\w.]+)\s*\}\}/g, (_m, path: string) => {
        const [first, block, name] = path.split(".")
        const found =
          first === "outputs" ? outputs[block!]?.[name!] : (inputs[first!] as string | undefined)
        if (typeof found !== "string" || found.includes("{{")) missing = true
        return String(found)
      })
      return missing ? text : out
    }
    const resolveValue = (value: unknown): unknown => {
      if (typeof value === "string") return resolveString(value)
      if (Array.isArray(value)) return value.map(resolveValue)
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [resolveString(k), resolveValue(v)]),
        )
      }
      return value
    }
    return Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, resolveValue(v)]))
  }

  function renderWithResolver(
    boilerplateConfig: BoilerplateConfig,
    {
      blockOutputs = {},
      blockInputs = {},
      importedValues = {},
    }: {
      blockOutputs?: RunbookContextType["blockOutputs"]
      blockInputs?: RunbookContextType["blockInputs"]
      importedValues?: Record<string, unknown>
    } = {},
  ) {
    const invoke = vi.fn(async (channel: string, request: ResolveRequest) => {
      if (channel !== "boilerplate:resolve-inputs") throw new Error(`unexpected ${channel}`)
      return { inputs: fakeResolve(request) }
    })
    const api = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI
    const utils = render(
      <ApiProvider api={api}>
        <RunbookStateStub blockOutputs={blockOutputs} blockInputs={blockInputs}>
          <BoilerplateInputsForm
            id="tpl"
            blockType="Template"
            boilerplateConfig={boilerplateConfig}
            enableAutoRender={false}
            variant="standard"
            importedValues={importedValues}
          />
        </RunbookStateStub>
      </ApiProvider>,
    )
    const requests = () => invoke.mock.calls.map(([, request]) => request)
    return { ...utils, invoke, requests }
  }

  const linkedConfig: BoilerplateConfig = {
    variables: [
      { name: "ProjectName", type: "string", description: "", default: "acme" },
      {
        name: "BucketName",
        type: "string",
        description: "",
        default: "{{ .ProjectName }}-state",
      },
      {
        name: "Repos",
        type: "list",
        description: "",
        default: ["github.com/acme/catalog", "github.com/{{ .ProjectName }}/modules"],
      },
      {
        name: "Tags",
        type: "map",
        description: "",
        default: { "{{ .ProjectName }}:Team": "DevOps" },
      },
    ],
  }

  it("shows what each linked value comes to", async () => {
    const { container } = renderWithResolver(linkedConfig)

    // The field's label names the chip; its text is what the value comes to
    await waitFor(() =>
      expect(screen.getByLabelText("Bucket Name")).toHaveTextContent("acme-state"),
    )
    expect(screen.getByText("github.com/acme/modules")).toBeInTheDocument()
    expect(screen.getByText("acme:Team")).toBeInTheDocument()
    // Only the field's own label: no token names it
    expect(screen.getAllByText("Project Name")).toHaveLength(1)
    expect(container.textContent).not.toContain("{{")
  })

  it("follows a change to the value it is linked to", async () => {
    renderWithResolver(linkedConfig)
    await screen.findByText("acme-state")

    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "globex" } })

    expect(await screen.findByText("globex-state")).toBeInTheDocument()
    expect(screen.getByText("github.com/globex/modules")).toBeInTheDocument()
  })

  it("never sends a sensitive value, so what is built from one keeps its tokens", async () => {
    const { requests } = renderWithResolver({
      variables: [
        { name: "DbHost", type: "string", description: "", default: "db.internal" },
        {
          name: "DbPassword",
          type: "string",
          description: "",
          default: "hunter2",
          sensitive: true,
        },
        {
          name: "DbUrl",
          type: "string",
          description: "",
          default: "postgres://app:{{ .DbPassword }}@{{ .DbHost }}",
        },
        {
          name: "Replica",
          type: "string",
          description: "",
          default: "{{ .DbHost }}",
        },
      ],
    })

    await waitFor(() => expect(screen.getByLabelText("Replica")).toHaveTextContent("db.internal"))
    expect(screen.getByLabelText("DB URL")).toHaveTextContent("postgres://app:DB Password")
    expect(screen.getByTestId("field-DbUrl").innerHTML).not.toContain("hunter2")
    for (const request of requests()) {
      expect(request.inputs).not.toHaveProperty("DbPassword")
      expect(JSON.stringify(request)).not.toContain("hunter2")
    }
  })

  it("resolves against block outputs, but never a sensitive one", async () => {
    const { requests } = renderWithResolver(
      {
        variables: [
          {
            name: "AccountId",
            type: "string",
            description: "",
            default: "{{ .outputs.make_account.account_id }}",
          },
          {
            name: "Token",
            type: "string",
            description: "",
            default: "{{ .outputs.make_account.token }}",
          },
        ],
      },
      {
        blockOutputs: {
          make_account: {
            values: { account_id: "123456789012", token: sensitiveOutput("s3cr3t") },
            timestamp: "",
          },
        },
      },
    )

    await waitFor(() =>
      expect(screen.getByLabelText("Account ID")).toHaveTextContent("123456789012"),
    )
    expect(screen.getByLabelText("Token")).toHaveTextContent("Set automatically")
    for (const request of requests()) {
      expect(request.outputs).toEqual({ make_account: { account_id: "123456789012" } })
    }
  })

  // A Template's defaults can use the values it imports through inputsId.
  const upstreamConfig: BoilerplateConfig = {
    variables: [
      { name: "OrgName", type: "string", description: "" },
      { name: "ApiToken", type: "string", description: "", sensitive: true },
    ],
  }

  it("resolves against imported values, with the form's own values winning", async () => {
    const { requests } = renderWithResolver(
      {
        variables: [
          { name: "RepoName", type: "string", description: "", default: "{{ .OrgName }}-infra" },
          { name: "Region", type: "string", description: "", default: "{{ .UpstreamRegion }}" },
          { name: "UpstreamRegion", type: "string", description: "", default: "us-east-1" },
        ],
      },
      { importedValues: { OrgName: "acme", UpstreamRegion: "eu-west-1" } },
    )

    await waitFor(() => expect(screen.getByLabelText("Repo Name")).toHaveTextContent("acme-infra"))
    expect(screen.getByLabelText("Region")).toHaveTextContent("us-east-1")
    expect(requests()[0]!.inputs).toMatchObject({ OrgName: "acme", UpstreamRegion: "us-east-1" })
  })

  it("never sends an imported value that its own block marks sensitive", async () => {
    const { requests } = renderWithResolver(
      {
        variables: [
          { name: "RepoName", type: "string", description: "", default: "{{ .OrgName }}-infra" },
          {
            name: "AuthHeader",
            type: "string",
            description: "",
            default: "Bearer {{ .ApiToken }}",
          },
        ],
      },
      {
        importedValues: { OrgName: "acme", ApiToken: "ghp_s3cr3t" },
        blockInputs: { upstream: { values: {}, config: upstreamConfig } },
      },
    )

    await waitFor(() => expect(screen.getByLabelText("Repo Name")).toHaveTextContent("acme-infra"))
    expect(screen.getByLabelText("Auth Header")).toHaveTextContent("Bearer API Token")
    expect(screen.getByTestId("field-AuthHeader").innerHTML).not.toContain("ghp_s3cr3t")
    for (const request of requests()) {
      expect(request.inputs).not.toHaveProperty("ApiToken")
    }
  })

  it("asks nothing when no value is linked", () => {
    const { invoke } = renderWithResolver(config)

    expect(invoke).not.toHaveBeenCalled()
  })
})

// A linked default that uses an output of a block that isn't on the page can
// never be filled in: the form shows it as an error until someone replaces it.
describe("BoilerplateInputsForm linked default using a block that isn't on the page", () => {
  const accountConfig: BoilerplateConfig = {
    variables: [
      { name: "Region", type: "string", description: "", default: "us-east-1" },
      {
        name: "AccountAlias",
        type: "string",
        description: "",
        default: "acme-{{ .outputs.create_account.account_id }}",
      },
    ],
  }

  function PageBlock({ id }: { id: string }) {
    useComponentIdRegistry(id, "Command")
    return null
  }

  // Reads the page-level error report, as the summary banner does.
  let reported: ReportedError[] = []
  function ReportProbe() {
    reported = useErrorReporting().errors
    return null
  }

  function renderOnPage(blockIds: string[], boilerplateConfig = accountConfig) {
    const onGenerate = vi.fn()
    const form = (
      <BoilerplateInputsForm
        id="tpl"
        blockType="Template"
        boilerplateConfig={boilerplateConfig}
        onGenerate={onGenerate}
        enableAutoRender={false}
        variant="standard"
      />
    )
    const page = (withForm: boolean) => (
      <ErrorReportingProvider>
        <ComponentIdRegistryProvider>
          {blockIds.map((blockId) => (
            <PageBlock key={blockId} id={blockId} />
          ))}
          {withForm && form}
          <ReportProbe />
        </ComponentIdRegistryProvider>
      </ErrorReportingProvider>
    )
    const utils = render(page(true))
    const block = () => utils.container.querySelector(".runbook-block") as HTMLElement
    return { ...utils, onGenerate, block, removeForm: () => utils.rerender(page(false)) }
  }

  it("shows the error on the field and turns the block red, without the field being touched", async () => {
    const { block } = renderOnPage(["tpl", "other-block"])

    expect(
      await screen.findByText(
        'Uses an output of block "create_account", but no block on this page has that id, so it can\'t be filled in. Enter a value instead.',
      ),
    ).toBeInTheDocument()
    expect(block().className).toContain("bg-destructive-muted")
  })

  it("doesn't generate until the value is replaced", async () => {
    const { onGenerate, block } = renderOnPage(["tpl", "other-block"])
    await screen.findByText(/no block on this page has that id/)

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).not.toHaveBeenCalled()
    expect(screen.getByText(/There is/)).toHaveTextContent("There is 1 validation error above")

    fireEvent.click(screen.getByRole("button", { name: "Clear linked value" }))
    fireEvent.change(screen.getByLabelText("Account Alias"), { target: { value: "acme-prod" } })
    expect(screen.queryByText(/no block on this page has that id/)).toBeNull()
    expect(block().className).not.toContain("bg-destructive-muted")

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).toHaveBeenCalledWith({ Region: "us-east-1", AccountAlias: "acme-prod" })
  })

  it("adds it to the page-level error report until the value is replaced", async () => {
    renderOnPage(["tpl", "other-block"])
    await screen.findByText(/no block on this page has that id/)

    expect(reported).toEqual([
      {
        componentId: "tpl:missing-output-blocks",
        componentType: "Template",
        severity: "error",
        message:
          'Account Alias uses an output of block "create_account", which isn\'t on this page.',
      },
    ])

    fireEvent.click(screen.getByRole("button", { name: "Clear linked value" }))
    expect(reported).toEqual([])
  })

  it("takes it out of the page-level error report when the block goes away", async () => {
    const { removeForm } = renderOnPage(["tpl", "other-block"])
    await screen.findByText(/no block on this page has that id/)
    expect(reported).toHaveLength(1)

    removeForm()
    expect(reported).toEqual([])
  })

  it("shows a hidden field that uses it, locked, without asking for another value", async () => {
    const { block } = renderOnPage(["tpl"], {
      variables: [
        {
          name: "Provider",
          type: "enum",
          description: "",
          options: ["github", "gitlab"],
          default: "{{ .outputs.git_auth.GIT_PROVIDER }}",
          locked: true,
          hidden: true,
        },
      ],
    })

    expect(
      await screen.findByText(
        'Uses an output of block "git_auth", but no block on this page has that id, so it can\'t be filled in.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId("field-Provider")).toHaveTextContent("(locked)")
    expect(block().className).toContain("bg-destructive-muted")
    expect(reported).toEqual([
      expect.objectContaining({
        message: 'Provider uses an output of block "git_auth", which isn\'t on this page.',
      }),
    ])
  })

  it("is only waiting, not an error, when the block is on the page", async () => {
    const { block, onGenerate } = renderOnPage(["tpl", "create-account"])

    expect(await screen.findByTitle("Waiting for create-account to run")).toBeInTheDocument()
    expect(screen.queryByText(/no block on this page/)).toBeNull()
    expect(reported).toEqual([])
    expect(block().className).not.toContain("bg-destructive-muted")
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).toHaveBeenCalled()
  })
})
