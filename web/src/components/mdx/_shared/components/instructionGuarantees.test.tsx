import { describe, it, expect } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ApiProvider } from "@/contexts/ApiContext"
import { Instruction } from "./Instruction"
import type { TemplateContext } from "@/lib/templateUtils"
import { sensitiveOutput } from "@/lib/outputValues"
import { makeTestApi, type Handler, type Params, type TestApi } from "@/test/test-api"

/**
 * Cross-cutting instruction-mode guarantees that live in the shared resolution
 * path (spec §10):
 *  - the only IPC channel touched while resolving is the side-effect-free
 *    boilerplate:render-inline — never exec:run, render-to-disk, clone, push, PR;
 *  - every `{{ .inputs.* }}` / `{{ .outputs.* }}` value reference in a
 *    displayed command resolves to a value or a `<name>` placeholder, whether or
 *    not the engine is available;
 *  - an input referenced only inside template logic is never given a
 *    placeholder, so that logic is never evaluated against one;
 *  - an input that has a value, even `''`, is never given a placeholder, so
 *    the command's logic decides as it would when the command runs;
 *  - a sensitive output is never shown, as its value or as `<redacted>`: the
 *    user pastes it, as they would an output that hasn't been produced.
 */

const FORBIDDEN_CHANNELS = [
  "exec:run",
  "boilerplate:render",
  "git:clone",
  "git:push",
  "git:pull-request",
  "git:delete-branch",
]

/** Renders `ui` with an IPC API whose render-inline, the template engine, is `engine`. */
function renderWithEngine(ui: React.ReactNode, engine: Handler<"boilerplate:render-inline">) {
  const testApi = makeTestApi({ "boilerplate:render-inline": engine })
  render(
    <ApiProvider api={testApi.api}>
      <TooltipProvider>{ui}</TooltipProvider>
    </ApiProvider>,
  )
  return testApi
}

/** The engine when it can't be reached. */
const offline = () => Promise.reject(new Error("engine offline"))

/** The `inputs` map a render request renders with. */
function inputsOf(params: Params<"boilerplate:render-inline">): Record<string, unknown> {
  const value = params.inputs?.find((v) => v.name === "inputs")?.value
  return value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value))
    : {}
}

describe("instruction mode — nothing runs", () => {
  it("only ever calls boilerplate:render-inline while resolving a command", async () => {
    const ctx: TemplateContext = { inputs: { bucket: "my-bucket" }, outputs: {} }

    const testApi = renderWithEngine(
      <Instruction
        title="Run this:"
        command="aws s3 ls {{ .inputs.bucket }}"
        templateContext={ctx}
      />,
      () => ({ renderedFiles: { "cmd-0": { content: "aws s3 ls my-bucket" } } }),
    )

    await waitFor(() => expect(testApi.invoke).toHaveBeenCalled())
    const channels = testApi.calls.map((c) => c.channel)
    for (const channel of channels) {
      expect(FORBIDDEN_CHANNELS).not.toContain(channel)
    }
    expect(channels.every((c) => c === "boilerplate:render-inline")).toBe(true)
  })
})

describe("instruction mode — no unresolved template references", () => {
  it("never displays a command containing {{ — input, output, and empty cases", async () => {
    // Engine unavailable here (render-inline rejects) → client-side fallback, which is
    // the backstop that guarantees no raw template survives.
    const ctx: TemplateContext = { inputs: { region: "us-east-1" }, outputs: {} }

    renderWithEngine(
      <Instruction
        title="Run this:"
        command={[
          "aws configure set region {{ .inputs.region }}",
          "echo {{ .outputs.create_account.account_id }}",
        ]}
        templateContext={ctx}
      />,
      offline,
    )

    await waitFor(() =>
      expect(screen.getByText("aws configure set region us-east-1")).toBeInTheDocument(),
    )
    // The output reference resolves to a <placeholder>, never a raw {{ }}.
    expect(screen.getByText("echo <account_id>")).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("{{")
  })

  it("shows an unset input as a <name> placeholder and resolves a nested input, engine offline", async () => {
    const ctx: TemplateContext = {
      inputs: { prefix: undefined, _module: { source: "git::x" } },
      outputs: {},
    }

    renderWithEngine(
      <Instruction
        title="Run this:"
        command={[
          "aws s3 ls s3://{{ .inputs.bucket }}/{{ .inputs.prefix }}",
          "echo {{ .inputs._module.source }}",
        ]}
        templateContext={ctx}
      />,
      offline,
    )

    await screen.findByText(/simplified resolver/)
    expect(screen.getByText("aws s3 ls s3://<bucket>/<prefix>")).toBeInTheDocument()
    expect(screen.getByText("echo git::x")).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("{{")
  })

  it("sends the engine a <name> placeholder for an unset input", async () => {
    const testApi = renderWithEngine(
      <Instruction
        title="Run this:"
        command="aws s3 ls {{ .inputs.bucket }}"
        templateContext={{ inputs: { bucket: undefined }, outputs: {} }}
      />,
      () => ({ renderedFiles: { "cmd-0": { content: "aws s3 ls <bucket>" } } }),
    )

    await waitFor(() => expect(testApi.invoke).toHaveBeenCalled())
    const [params] = testApi.callsTo("boilerplate:render-inline")
    expect(params!.inputs).toContainEqual(
      expect.objectContaining({ name: "inputs", value: { bucket: "<bucket>" } }),
    )
    expect(await screen.findByText("aws s3 ls <bucket>")).toBeInTheDocument()
    expect(screen.queryByText(/simplified resolver/)).toBeNull()
  })

  it("falls back, and says so, when the engine returns a [template error] marker or no result", async () => {
    renderWithEngine(
      <Instruction
        title="Run this:"
        command={["aws s3 ls {{ .inputs.bucket }}", "echo {{ .inputs.region }}"]}
        templateContext={{ inputs: { region: "us-east-1" }, outputs: {} }}
      />,
      () => ({
        renderedFiles: {
          "cmd-0": {
            content:
              '[template error: template: cmd-0:1:12: executing "cmd-0" at <.inputs.bucket>: map has no entry for key "bucket"]',
          },
          // No 'cmd-1' in the response.
        },
      }),
    )

    await screen.findByText(/simplified resolver/)
    expect(screen.getByText("aws s3 ls <bucket>")).toBeInTheDocument()
    expect(screen.getByText("echo us-east-1")).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("[template error")
    expect(document.body.textContent).not.toContain("{{")
  })

  it("keeps an engine result that contains {{ on purpose, with no fallback", async () => {
    // The documented escape for passing `{{ }}` through to a tool. The engine
    // renders the raw string to a literal `{{.Names}}`; that is the command.
    renderWithEngine(
      <Instruction
        title="Run this:"
        command={"docker ps --format '{{`{{.Names}}`}}' --filter name={{ .inputs.name }}"}
        templateContext={{ inputs: { name: "web" }, outputs: {} }}
      />,
      () => ({
        renderedFiles: {
          "cmd-0": { content: "docker ps --format '{{.Names}}' --filter name=web" },
        },
      }),
    )

    expect(
      await screen.findByText("docker ps --format '{{.Names}}' --filter name=web"),
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("{{`")
    expect(screen.queryByText(/simplified resolver/)).toBeNull()
  })

  it("gives no placeholder to an unset input used only in a conditional", async () => {
    // A stand-in for the engine: `if` on a missing key is an error (the WASM
    // engine renders with OnMissingKey=ExitWithError); any set value is truthy.
    const engine: Handler<"boilerplate:render-inline"> = (params) => {
      const inputs = inputsOf(params)
      const content = !("auto_approve" in inputs)
        ? '[template error: template: cmd-0:1:24: executing "cmd-0" at <.inputs.auto_approve>: map has no entry for key "auto_approve"]'
        : inputs.auto_approve
          ? "terraform destroy -auto-approve"
          : "terraform destroy "
      return { renderedFiles: { "cmd-0": { content } } }
    }
    const command = "terraform destroy {{ if .inputs.auto_approve }}-auto-approve{{ end }}"

    const testApi = renderWithEngine(
      <Instruction
        title="Run this:"
        command={command}
        templateContext={{ inputs: { auto_approve: undefined }, outputs: {} }}
      />,
      engine,
    )

    // The unchecked, unset bool gets no placeholder: the engine can't decide
    // the branch, so the logic is shown as written, flagged by the note.
    await screen.findByText(/simplified resolver/)
    expect(screen.getByText(command)).toBeInTheDocument()
    expect(screen.queryByText("terraform destroy -auto-approve")).toBeNull()
    const [params] = testApi.callsTo("boilerplate:render-inline")
    expect(params!.inputs).toContainEqual(
      expect.objectContaining({ name: "inputs", value: { auto_approve: undefined } }),
    )
  })

  it("renders an empty optional input as empty, not as a placeholder that takes the branch", async () => {
    // A stand-in for the engine: a missing key is an error; '' is falsy.
    const engine: Handler<"boilerplate:render-inline"> = (params) => {
      const inputs = inputsOf(params)
      const varFile = inputs.var_file
      const content = !("var_file" in inputs)
        ? '[template error: template: cmd-0:1:21: executing "cmd-0" at <.inputs.var_file>: map has no entry for key "var_file"]'
        : typeof varFile === "string" && varFile
          ? `terraform apply -var-file=${varFile}`
          : "terraform apply "
      return { renderedFiles: { "cmd-0": { content } } }
    }

    const testApi = renderWithEngine(
      <Instruction
        title="Run this:"
        command="terraform apply {{ if .inputs.var_file }}-var-file={{ .inputs.var_file }}{{ end }}"
        templateContext={{ inputs: { var_file: "" }, outputs: {} }}
      />,
      engine,
    )

    await waitFor(() => expect(testApi.invoke).toHaveBeenCalled())
    const [params] = testApi.callsTo("boilerplate:render-inline")
    expect(params!.inputs).toContainEqual(
      expect.objectContaining({ name: "inputs", value: { var_file: "" } }),
    )
    await waitFor(() =>
      expect(document.querySelector("code")?.textContent).toBe("terraform apply "),
    )
    expect(document.body.textContent).not.toContain("<var_file>")
    expect(screen.queryByText(/simplified resolver/)).toBeNull()
  })
})

describe("instruction mode — sensitive outputs", () => {
  // The user ran the step that produced the token, then switched to
  // instruction mode, so the context holds it. Instruction mode never shows a
  // sensitive value, so it asks for the token as if the step hadn't run.
  const command =
    'curl -H "Authorization: Bearer {{ .outputs.fetch_token.api_token }}" {{ .outputs.fetch_token.url }}'
  const ctx: TemplateContext = {
    inputs: {},
    outputs: { fetch_token: { url: "https://api", api_token: sensitiveOutput("real-secret") } },
  }
  const sentOutputs = (testApi: TestApi) =>
    testApi
      .callsTo("boilerplate:render-inline")
      .map((params) => params.inputs?.find((v) => v.name === "outputs")?.value)

  it("prompts for the value and sends the engine a placeholder, then the pasted value", async () => {
    const testApi = renderWithEngine(
      <Instruction title="Run this:" command={command} templateContext={ctx} />,
      () => ({ renderedFiles: {} }),
    )

    const field = screen.getByPlaceholderText(/paste the api_token value/i)
    await waitFor(() => expect(testApi.invoke).toHaveBeenCalled())
    expect(sentOutputs(testApi).at(-1)).toEqual({
      fetch_token: { url: "https://api", api_token: "<api_token>" },
    })

    fireEvent.change(field, { target: { value: "pasted-token" } })
    await waitFor(() =>
      expect(sentOutputs(testApi).at(-1)).toEqual({
        fetch_token: { url: "https://api", api_token: "pasted-token" },
      }),
    )
    expect(JSON.stringify(testApi.calls)).not.toMatch(/real-secret|<redacted>/)
  })

  it("shows a placeholder, never the value or <redacted>, engine offline", async () => {
    renderWithEngine(
      <Instruction title="Run this:" command={command} templateContext={ctx} />,
      offline,
    )

    await screen.findByText(/simplified resolver/)
    expect(
      screen.getByText('curl -H "Authorization: Bearer <api_token>" https://api'),
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/real-secret|<redacted>/)
  })
})
