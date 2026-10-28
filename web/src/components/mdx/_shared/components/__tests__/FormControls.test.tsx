import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FormControl } from "../FormControls"
import type { FieldLinks } from "../TemplateValue"
import { sensitiveOutput } from "@/lib/outputValues"
import type { BoilerplateVariable } from "@/types/boilerplateVariable"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import { RunbookStateStub } from "@/test/test-utils"
import { ComponentIdRegistryProvider, useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"

// Each select must display the value that is actually in form state, so the
// user never sees a choice that downstream blocks don't receive.
describe("FormControls selects match form state", () => {
  it("shows a placeholder for an enum with no value, and picking the first option fires onChange", () => {
    const variable: BoilerplateVariable = {
      name: "Env",
      type: "enum",
      description: "",
      options: ["dev", "prod"],
    }
    const onChange = vi.fn()
    render(<FormControl id="f" variable={variable} value={undefined} onChange={onChange} />)

    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select.value).toBe("")
    expect(screen.getByRole("option", { name: "Select…" })).toBeInTheDocument()

    fireEvent.change(select, { target: { value: "dev" } })
    expect(onChange).toHaveBeenCalledWith("dev")
  })

  it("shows no placeholder once the enum has a value", () => {
    const variable: BoilerplateVariable = {
      name: "Env",
      type: "enum",
      description: "",
      options: ["dev", "prod"],
    }
    render(<FormControl id="f" variable={variable} value="prod" onChange={vi.fn()} />)

    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("prod")
    expect(screen.queryByRole("option", { name: "Select…" })).toBeNull()
  })

  it("shows an enum value that is not one of the options instead of the first option", () => {
    const variable: BoilerplateVariable = {
      name: "Env",
      type: "enum",
      description: "",
      options: ["dev", "prod"],
    }
    render(<FormControl id="f" variable={variable} value="staging" onChange={vi.fn()} />)

    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("staging")
    expect(screen.getByRole("option", { name: "staging" })).toBeInTheDocument()
  })

  it("selects a listed numeric enum option instead of an unlisted duplicate", () => {
    // parseBoilerplateConfig passes enum options through as YAML parsed them,
    // so `options: [1.28, 1.29]` arrives as numbers.
    const variable: BoilerplateVariable = {
      name: "Version",
      type: "enum",
      description: "",
      options: [1.28, 1.29] as unknown as string[],
    }
    const onChange = vi.fn()
    const { rerender } = render(
      <FormControl id="f" variable={variable} value={1.29} onChange={onChange} />,
    )

    const select = screen.getByRole("combobox") as HTMLSelectElement
    const optionLabels = () => Array.from(select.options).map((o) => o.text)
    expect(select.value).toBe("1.29")
    expect(optionLabels()).toEqual(["1.28", "1.29"])
    expect(select.selectedOptions[0]!.disabled).toBe(false)

    fireEvent.change(select, { target: { value: "1.28" } })
    expect(onChange).toHaveBeenCalledWith("1.28")
    // The picked value comes back as a string
    rerender(<FormControl id="f" variable={variable} value="1.28" onChange={onChange} />)
    expect(select.value).toBe("1.28")
    expect(optionLabels()).toEqual(["1.28", "1.29"])
    expect(select.selectedOptions[0]!.disabled).toBe(false)
  })

  it("keeps a real '' enum option selectable instead of showing the placeholder again", () => {
    const variable: BoilerplateVariable = {
      name: "LogLevel",
      type: "enum",
      description: "",
      options: ["", "DEBUG"],
    }
    const onChange = vi.fn()
    const { rerender } = render(
      <FormControl id="f" variable={variable} value={undefined} onChange={onChange} />,
    )

    // No value yet: the placeholder is shown, not the blank option
    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select.selectedOptions[0]!.text).toBe("Select…")

    fireEvent.change(select, { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith("")

    // Once '' is the value, the real blank option is the selected one
    rerender(<FormControl id="f" variable={variable} value="" onChange={onChange} />)
    expect(screen.queryByRole("option", { name: "Select…" })).toBeNull()
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "DEBUG"])
    expect(select.value).toBe("")
    expect(select.selectedOptions[0]!.disabled).toBe(false)
  })

  it("saves an untouched bool field of a map entry as 'false'", () => {
    const variable: BoilerplateVariable = {
      name: "Users",
      type: "map",
      description: "",
      schema: { email: "string", admin: "bool" },
    }
    const onChange = vi.fn()
    render(<FormControl id="f" variable={variable} value={{}} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    fireEvent.change(screen.getByLabelText(/Entry name/), { target: { value: "alice" } })
    fireEvent.change(screen.getByLabelText(/email/), { target: { value: "a@example.com" } })
    // The admin select displays 'false' but is never touched.
    expect((screen.getByLabelText(/admin/) as HTMLSelectElement).value).toBe("false")
    fireEvent.click(screen.getByRole("button", { name: /Save Entry/ }))

    expect(onChange).toHaveBeenCalledWith({ alice: { email: "a@example.com", admin: "false" } })
  })

  it("emits the displayed false for an untouched bool element of a tuple", () => {
    const variable: BoilerplateVariable = {
      name: "Pair",
      type: "list",
      description: "",
      schema: { "0": "string", "1": "bool" },
    }
    const onChange = vi.fn()
    render(<FormControl id="f" variable={variable} value={undefined} onChange={onChange} />)

    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("false")
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } })

    expect(onChange).toHaveBeenCalledWith(["x", false])
  })

  it("fills a missing bool element of a short tuple array with the displayed false", () => {
    const variable: BoilerplateVariable = {
      name: "Pair",
      type: "list",
      description: "",
      schema: { "0": "string", "1": "bool" },
    }
    const onChange = vi.fn()
    render(<FormControl id="f" variable={variable} value={[]} onChange={onChange} />)

    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("false")
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } })

    expect(onChange).toHaveBeenCalledWith(["x", false])
  })

  // Map fields and imported values can hold bools as strings; Boolean('false') is true.
  it.each([
    [true, true],
    ["true", true],
    [false, false],
    ["false", false],
    [undefined, false],
  ])("checks a bool checkbox for %j only when it is true", (value, checked) => {
    const variable: BoilerplateVariable = { name: "Flag", type: "bool", description: "" }
    render(<FormControl id="f" variable={variable} value={value} onChange={vi.fn()} />)

    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(checked)
  })
})

// A boilerplate default can be an expression over other variables, like
// `{{ .SecurityModulesVersion }}`. The form keeps that expression as the value
// (main resolves it when rendering) but shows it as its text and chips, never
// as raw `{{ }}` text. Each chip takes a value in its place when clicked.
describe("FormControls template-valued values", () => {
  const stringVar = (overrides: Partial<BoilerplateVariable> = {}): BoilerplateVariable => ({
    name: "ModuleVersion",
    type: "string",
    description: "",
    ...overrides,
  })
  const expectNoRawTemplateText = (container: HTMLElement) => {
    expect(container.textContent).not.toContain("{{")
    for (const input of Array.from(container.querySelectorAll("input, select"))) {
      expect((input as HTMLInputElement).value).not.toContain("{{")
    }
  }
  /** What the form gives a field's chips: the values of other variables, and those entered. */
  const fieldLinks = (overrides: Partial<FieldLinks> = {}): FieldLinks => ({
    variableValue: () => undefined,
    isSensitive: () => false,
    entered: {},
    enter: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  })

  it("shows a linked string value as a chip in a field-sized box the label points at", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="{{ .SecurityModulesVersion }}"
        onChange={vi.fn()}
        links={fieldLinks()}
      />,
    )

    expect(screen.queryByRole("textbox")).toBeNull()
    expect(container.querySelector("output#f-ModuleVersion")).toHaveTextContent(
      "Security Modules Version",
    )
    expect(
      screen.getByRole("button", { name: /^Security Modules Version: The value of/ }),
    ).toHaveAttribute("data-state", "linked")
    expect(container.querySelector('[title="{{ .SecurityModulesVersion }}"]')).not.toBeNull()
    expectNoRawTemplateText(container)
  })

  it("keeps the literal text around a reference", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="aws-sso@{{ .EmailDomainName }}"
        onChange={vi.fn()}
        links={fieldLinks()}
      />,
    )

    expect(container.querySelector("output")).toHaveTextContent("aws-sso@Email Domain Name")
    expectNoRawTemplateText(container)
  })

  it("shows the value of the variable a chip links to once the form knows it", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="aws-sso@{{ .EmailDomainName }}"
        onChange={vi.fn()}
        links={fieldLinks({
          variableValue: (name) => (name === "EmailDomainName" ? "acme.io" : undefined),
        })}
      />,
    )

    expect(container.querySelector("output")).toHaveTextContent("aws-sso@acme.io")
    expect(screen.getByRole("button", { name: "Email Domain Name: acme.io" })).toBeInTheDocument()
  })

  it("summarises a computed value as one chip", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        onChange={vi.fn()}
        value={'{{ if eq .SCMProvider "GitHub" }}v4{{ else }}v1{{ end }}'}
        links={fieldLinks()}
      />,
    )

    expect(screen.getAllByRole("button", { name: /^Based on SCM Provider/ })).toHaveLength(1)
    expectNoRawTemplateText(container)
  })

  it("turns a chip into a field in its place, which enters the value for that variable", async () => {
    const user = userEvent.setup()
    const links = fieldLinks({ variableValue: () => "acme.io" })
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="aws-sso@{{ .EmailDomainName }}"
        onChange={vi.fn()}
        links={links}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Email Domain Name: acme.io" }))
    const field = screen.getByLabelText("Value for Email Domain Name")
    expect(field).toHaveFocus()
    expect(field).toHaveValue("acme.io")
    expect(container.querySelector("output")).toContainElement(field)

    await user.keyboard("globex.io{Enter}")
    expect(links.enter).toHaveBeenCalledWith("inputs.EmailDomainName", "globex.io")
  })

  it("enters a value for a block output, and for a whole computed value, under their keys", async () => {
    const user = userEvent.setup()
    const links = fieldLinks()
    render(
      <>
        <FormControl
          id="f"
          variable={stringVar({ name: "Alias" })}
          value="acme-{{ .outputs.make-account.account_id }}"
          onChange={vi.fn()}
          links={links}
        />
        <FormControl
          id="f"
          variable={stringVar({ name: "Size" })}
          value='{{ if eq .Env "prod" }}large{{ else }}small{{ end }}'
          onChange={vi.fn()}
          links={links}
        />
      </>,
    )

    await user.click(screen.getByRole("button", { name: /^make-account\.account_id/ }))
    await user.keyboard("123{Enter}")
    expect(links.enter).toHaveBeenCalledWith("outputs.make_account.account_id", "123")

    await user.click(screen.getByRole("button", { name: /^Based on Env/ }))
    await user.keyboard("medium{Enter}")
    expect(links.enter).toHaveBeenCalledWith(
      '={{ if eq .Env "prod" }}large{{ else }}small{{ end }}',
      "medium",
    )
  })

  it("shows an entered value in its field, with a button that resets it", async () => {
    const user = userEvent.setup()
    const links = fieldLinks({ entered: { "inputs.EmailDomainName": "globex.io" } })
    render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="aws-sso@{{ .EmailDomainName }}"
        onChange={vi.fn()}
        links={links}
      />,
    )

    const field = screen.getByLabelText("Value for Email Domain Name")
    expect(field).toHaveValue("globex.io")
    expect(field).toHaveAttribute("data-state", "entered")

    await user.click(screen.getByRole("button", { name: "Reset Email Domain Name" }))
    expect(links.reset).toHaveBeenCalledWith("inputs.EmailDomainName")
  })

  it("asks for a value in place of a sensitive variable in a password field", async () => {
    const user = userEvent.setup()
    render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="postgres://app:{{ .DbPassword }}@db"
        onChange={vi.fn()}
        links={fieldLinks({ isSensitive: (name) => name === "DbPassword" })}
      />,
    )

    await user.click(screen.getByRole("button", { name: /^DB Password/ }))
    expect(screen.getByLabelText("Value for DB Password")).toHaveAttribute("type", "password")
  })

  it("clears the link into an empty, focused textbox", () => {
    const onChange = vi.fn()
    const variable = stringVar()
    const { rerender } = render(
      <FormControl
        id="f"
        variable={variable}
        value="{{ .SecurityModulesVersion }}"
        onChange={onChange}
        links={fieldLinks()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Clear linked value" }))
    expect(onChange).toHaveBeenCalledWith("")

    rerender(<FormControl id="f" variable={variable} value="" onChange={onChange} />)
    const input = screen.getByRole("textbox") as HTMLInputElement
    expect(input.value).toBe("")
    expect(input).toHaveFocus()
  })

  it.each([
    ["disabled", true, fieldLinks()],
    ["given nowhere to keep a value", false, undefined],
  ])("shows a linked value's chips with nothing to click when %s", (_case, disabled, links) => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="{{ .SecurityModulesVersion }}"
        onChange={vi.fn()}
        disabled={disabled}
        links={links}
      />,
    )

    expect(screen.getByText("Security Modules Version")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Security Modules Version/ })).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expectNoRawTemplateText(container)
  })

  it("shows a linked sensitive value as one chip, which takes a value in a password field", async () => {
    const user = userEvent.setup()
    const links = fieldLinks()
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar({ sensitive: true })}
        value="{{ .SharedSecret }}"
        onChange={vi.fn()}
        links={links}
      />,
    )

    expect(container.querySelector('input[type="password"]')).toBeNull()
    await user.click(screen.getByRole("button", { name: /^Same as Shared Secret/ }))
    expect(container.querySelector('input[type="password"]')).toHaveFocus()
    await user.keyboard("hunter2{Enter}")
    expect(links.enter).toHaveBeenCalledWith("={{ .SharedSecret }}", "hunter2")
  })

  it("never puts a value entered for a sensitive field in the page", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar({ sensitive: true })}
        value="{{ .SharedSecret }}"
        onChange={vi.fn()}
        links={fieldLinks({ entered: { "={{ .SharedSecret }}": "hunter2" } })}
      />,
    )

    expect(screen.getByLabelText("Value for Same as Shared Secret")).toHaveValue("")
    expect(container.innerHTML).not.toContain("hunter2")
  })

  // Only the names of the linked variables are shown: literal text in a
  // sensitive value can be a secret, and the expression holds all of it.
  it.each([false, true])(
    "never shows the literal text of a linked sensitive value (disabled: %s)",
    (disabled) => {
      const { container } = render(
        <FormControl
          id="f"
          variable={stringVar({ sensitive: true })}
          onChange={vi.fn()}
          disabled={disabled}
          value="postgres://admin:hunter2@{{ .DbHost }}/app"
          links={fieldLinks({ variableValue: () => "db.internal" })}
        />,
      )

      expect(screen.getByText("Based on DB Host")).toBeInTheDocument()
      expect(container.innerHTML).not.toContain("hunter2")
      expect(container.innerHTML).not.toContain("postgres://")
      expect(container.innerHTML).not.toContain("db.internal")
    },
  )

  it("still shows a plain string in a textbox", () => {
    render(<FormControl id="f" variable={stringVar()} value="v1.2.3" onChange={vi.fn()} />)

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("v1.2.3")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("keeps a textbox while the user types their own expression, and links it once they leave", () => {
    const onChange = vi.fn()
    const onBlur = vi.fn()
    const variable = stringVar()
    const links = fieldLinks()
    const { rerender } = render(
      <FormControl
        id="f"
        variable={variable}
        value=""
        onChange={onChange}
        onBlur={onBlur}
        links={links}
      />,
    )

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "{{ .inputs.A }}" } })
    rerender(
      <FormControl
        id="f"
        variable={variable}
        value="{{ .inputs.A }}"
        onChange={onChange}
        onBlur={onBlur}
        links={links}
      />,
    )

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("{{ .inputs.A }}")
    expect(screen.queryByRole("button", { name: "Clear linked value" })).toBeNull()

    fireEvent.blur(screen.getByRole("textbox"))
    expect(onBlur).toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByRole("button", { name: /^A: / })).toBeInTheDocument()
  })

  it("keeps a sensitive expression open while focus moves to its show button", () => {
    const variable = stringVar({ sensitive: true })
    const { container, rerender } = render(
      <FormControl id="f" variable={variable} value="" onChange={vi.fn()} links={fieldLinks()} />,
    )

    const input = container.querySelector('input[type="password"]')!
    fireEvent.change(input, { target: { value: "{{ .SharedSecret }}" } })
    rerender(
      <FormControl
        id="f"
        variable={variable}
        value="{{ .SharedSecret }}"
        onChange={vi.fn()}
        links={fieldLinks()}
      />,
    )
    const showButton = screen.getByRole("button", { name: "Show sensitive input" })
    fireEvent.blur(input, { relatedTarget: showButton })
    expect(container.querySelector('input[type="password"]')).not.toBeNull()

    fireEvent.blur(showButton, { relatedTarget: document.body })
    expect(container.querySelector("input")).toBeNull()
    expect(screen.getByRole("button", { name: /^Same as Shared Secret/ })).toBeInTheDocument()
  })

  it("shows a linked list entry with its chips, which take values, and removing it still works", async () => {
    const user = userEvent.setup()
    const variable: BoilerplateVariable = {
      name: "CatalogRepositories",
      type: "list",
      description: "",
    }
    const onChange = vi.fn()
    const links = fieldLinks({
      variableValue: (name) => (name === "RepoBaseUrl" ? "github.com" : undefined),
    })
    const value = ["github.com/acme/catalog", "{{ .RepoBaseUrl }}/{{ .InfraModulesRepoName }}"]
    const { container } = render(
      <FormControl id="f" variable={variable} value={value} onChange={onChange} links={links} />,
    )

    expect(screen.getByText("github.com/acme/catalog")).toBeInTheDocument()
    expect(container.querySelector(`[title="${value[1]}"]`)).toHaveTextContent(
      "github.com/Infra Modules Repo Name",
    )
    expectNoRawTemplateText(container)

    await user.click(screen.getByRole("button", { name: /^Infra Modules Repo Name/ }))
    await user.keyboard("infra-modules{Enter}")
    expect(links.enter).toHaveBeenCalledWith("inputs.InfraModulesRepoName", "infra-modules")

    fireEvent.click(screen.getAllByTitle("Remove entry")[1]!)
    expect(onChange).toHaveBeenCalledWith(["github.com/acme/catalog"])
  })

  it("shows the chips of a linked map key and a linked map value, with the values they know", () => {
    const variable: BoilerplateVariable = { name: "DefaultTags", type: "map", description: "" }
    const { container } = render(
      <FormControl
        id="f"
        variable={variable}
        onChange={vi.fn()}
        value={{ "{{ .OrgNamePrefix }}:Team": "DevOps", Owner: "{{ .TeamEmail }}" }}
        links={fieldLinks({
          variableValue: (name) => (name === "TeamEmail" ? "ops@acme.io" : undefined),
        })}
      />,
    )

    expect(screen.getByRole("button", { name: /^Org Name Prefix/ })).toBeInTheDocument()
    expect(screen.getByText("DevOps")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Team Email: ops@acme.io" })).toBeInTheDocument()
    expectNoRawTemplateText(container)
  })

  it("shows the chips of linked fields of a structured map entry", () => {
    const variable: BoilerplateVariable = {
      name: "Accounts",
      type: "map",
      description: "",
      schema: { email: "string", name: "string" },
    }
    const { container } = render(
      <FormControl
        id="f"
        variable={variable}
        onChange={vi.fn()}
        value={{ security: { email: "security@{{ .EmailDomainName }}", name: "Security" } }}
        links={fieldLinks({ variableValue: () => "acme.io" })}
      />,
    )

    expect(screen.getByText("security")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Email Domain Name: acme.io" })).toBeInTheDocument()
    expect(screen.getByText("Security")).toBeInTheDocument()
    expectNoRawTemplateText(container)
  })

  it("shows what a computed value comes to when it is known, with the expression on hover", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value='{{ if eq .Environment "prod" }}large{{ else }}small{{ end }}'
        resolvedValue="small"
        onChange={vi.fn()}
        links={fieldLinks()}
      />,
    )

    expect(screen.getByRole("button", { name: "Based on Environment: small" })).toBeInTheDocument()
    expect(
      container.querySelector(
        `[title='{{ if eq .Environment "prod" }}large{{ else }}small{{ end }}']`,
      ),
    ).not.toBeNull()
    expectNoRawTemplateText(container)
  })

  it.each([
    ["not resolved yet", undefined],
    ["unresolvable", "{{ now }}"],
    ["empty", ""],
  ])(
    "names what a computed value is based on when what it comes to is %s",
    (_case, resolvedValue) => {
      render(
        <FormControl
          id="f"
          variable={stringVar()}
          value="{{ now }}"
          resolvedValue={resolvedValue}
          onChange={vi.fn()}
          links={fieldLinks()}
        />,
      )

      expect(screen.getByRole("button", { name: /^Set automatically/ })).toHaveTextContent(
        "Set automatically",
      )
    },
  )

  // A value built from a block's output can't be known until that block runs.
  describe("waiting on a block that hasn't run", () => {
    const withOutputs = (ui: React.ReactNode, blockOutputs: RunbookContextType["blockOutputs"]) => (
      <RunbookStateStub blockOutputs={blockOutputs}>{ui}</RunbookStateStub>
    )
    const accountIdField = (props: Partial<React.ComponentProps<typeof FormControl>> = {}) => (
      <FormControl
        id="f"
        variable={stringVar()}
        value="acme-{{ .outputs.make_account.account_id }}"
        onChange={vi.fn()}
        links={fieldLinks()}
        {...props}
      />
    )

    it("shows its chip in yellow, naming the output and, on hover, the block", () => {
      render(withOutputs(accountIdField(), {}))

      const chip = screen.getByTitle(/Waiting for make_account to run/)
      expect(chip).toHaveTextContent("make_account.account_id")
      expect(chip).toHaveAttribute("data-state", "waiting")
      expect(chip.className).toContain("bg-warning-muted")
    })

    function PageBlock({ id }: { id: string }) {
      useComponentIdRegistry(id, "Command")
      return null
    }

    it("names the block by the id it is written with, not the one templates use", async () => {
      render(
        <ComponentIdRegistryProvider>
          <PageBlock id="make-account" />
          {withOutputs(accountIdField(), {})}
        </ComponentIdRegistryProvider>,
      )

      expect(await screen.findByTitle(/Waiting for make-account to run/)).toBeInTheDocument()
    })

    // No such block can ever run, so the value can never be filled in.
    it("shows its chip in red when no block on the page has that id", async () => {
      render(
        <ComponentIdRegistryProvider>
          <PageBlock id="other-block" />
          {withOutputs(accountIdField(), {})}
        </ComponentIdRegistryProvider>,
      )

      const chip = await screen.findByTitle(/No block on this page has the id "make_account"/)
      expect(chip).toHaveTextContent("make_account.account_id")
      expect(chip.className).toContain("bg-destructive-muted")
      expect(screen.queryByTitle(/Waiting for/)).toBeNull()
    })

    // Blocks register after their first render, so until then a block can't
    // be known to be missing.
    it("isn't red before any block has registered", () => {
      render(
        <ComponentIdRegistryProvider>
          {withOutputs(accountIdField(), {})}
        </ComponentIdRegistryProvider>,
      )

      expect(screen.getByTitle(/Waiting for make_account to run/)).toBeInTheDocument()
    })

    it("shows the chip in yellow for a sensitive value too", () => {
      render(withOutputs(accountIdField({ variable: stringVar({ sensitive: true }) }), {}))

      const chip = screen.getByTitle(/Waiting for make_account to run/)
      expect(chip).toHaveTextContent("Set automatically")
      expect(chip.className).toContain("bg-warning-muted")
    })

    it("shows the output, once the block has produced it", () => {
      const outputs = { make_account: { values: { account_id: "123456789012" }, timestamp: "" } }
      render(withOutputs(accountIdField(), outputs))

      expect(screen.queryByTitle(/Waiting for/)).toBeNull()
      const chip = screen.getByRole("button", { name: "make_account.account_id: 123456789012" })
      expect(chip).toHaveAttribute("data-state", "linked")
      expect(chip.className).toContain("bg-muted")
    })

    it("shows a secret output as <redacted>", () => {
      const outputs = {
        make_account: { values: { account_id: sensitiveOutput("s3cr3t") }, timestamp: "" },
      }
      const { container } = render(withOutputs(accountIdField(), outputs))

      expect(screen.getByRole("button", { name: /^make_account\.account_id/ })).toHaveTextContent(
        "<redacted>",
      )
      expect(container.innerHTML).not.toContain("s3cr3t")
    })

    it("shows an entered value in place of the output, which nothing waits for", () => {
      render(
        withOutputs(
          accountIdField({
            links: fieldLinks({ entered: { "outputs.make_account.account_id": "999" } }),
          }),
          {},
        ),
      )

      expect(screen.getByLabelText("Value for make_account.account_id")).toHaveValue("999")
      expect(screen.queryByTitle(/Waiting for/)).toBeNull()
    })

    it("shows a yellow list entry", () => {
      const variable: BoilerplateVariable = { name: "Accounts", type: "list", description: "" }
      render(
        withOutputs(
          <FormControl
            id="f"
            variable={variable}
            value={["111111111111", "{{ .outputs.make_account.account_id }}"]}
            onChange={vi.fn()}
          />,
          {},
        ),
      )

      expect(screen.getByText("111111111111")).toBeInTheDocument()
      expect(screen.getByTitle(/Waiting for make_account to run/)).toBeInTheDocument()
    })
  })

  it.each([false, true])(
    "never shows what a sensitive linked value comes to (disabled: %s)",
    (disabled) => {
      const { container } = render(
        <FormControl
          id="f"
          variable={stringVar({ sensitive: true })}
          value="postgres://admin:{{ .DbPassword }}@db/app"
          resolvedValue="postgres://admin:hunter2@db/app"
          onChange={vi.fn()}
          disabled={disabled}
          links={fieldLinks()}
        />,
      )

      expect(screen.getByText("Based on DB Password")).toBeInTheDocument()
      expect(container.innerHTML).not.toContain("hunter2")
    },
  )

  it("labels a linked enum value by what it comes to when that is known", () => {
    const variable: BoilerplateVariable = {
      name: "Env",
      type: "enum",
      description: "",
      options: ["dev", "prod"],
    }
    render(
      <FormControl
        id="f"
        variable={variable}
        value="{{ .DefaultEnv }}"
        resolvedValue="dev"
        onChange={vi.fn()}
      />,
    )

    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select.value).toBe("{{ .DefaultEnv }}")
    expect(select.selectedOptions[0]!.text).toBe("dev")
  })

  it("labels a linked enum value by what it is based on, keeping the expression as the value", () => {
    const variable: BoilerplateVariable = {
      name: "Env",
      type: "enum",
      description: "",
      options: ["dev", "prod"],
    }
    render(<FormControl id="f" variable={variable} value="{{ .DefaultEnv }}" onChange={vi.fn()} />)

    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select.value).toBe("{{ .DefaultEnv }}")
    expect(select.selectedOptions[0]!.text).toBe("Same as Default Env")
  })
})
