import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FormControl } from "../FormControls"
import type { BoilerplateVariable } from "@/types/boilerplateVariable"

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
// (main resolves it when rendering) but shows it as linked tokens, never as
// raw `{{ }}` text.
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

  it("shows a linked string value as a token instead of a textbox", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="{{ .SecurityModulesVersion }}"
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryByRole("textbox")).toBeNull()
    const chip = screen.getByRole("button", { name: /Security Modules Version/ })
    expect(chip.id).toBe("f-ModuleVersion")
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
      />,
    )

    expect(screen.getByRole("button", { name: /aws-sso@\s*Email Domain Name/ })).toBeInTheDocument()
    expectNoRawTemplateText(container)
  })

  it("summarises a computed value", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        onChange={vi.fn()}
        value={'{{ if eq .SCMProvider "GitHub" }}v4{{ else }}v1{{ end }}'}
      />,
    )

    expect(screen.getByRole("button", { name: /Based on SCM Provider/ })).toBeInTheDocument()
    expectNoRawTemplateText(container)
  })

  it("expands to the raw expression in a focused textbox when clicked, and stays a textbox while editing", () => {
    const onChange = vi.fn()
    const variable = stringVar()
    const { rerender } = render(
      <FormControl
        id="f"
        variable={variable}
        value="{{ .SecurityModulesVersion }}"
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /Security Modules Version/ }))

    const input = screen.getByRole("textbox") as HTMLInputElement
    expect(input.value).toBe("{{ .SecurityModulesVersion }}")
    expect(input.id).toBe("f-ModuleVersion")
    expect(input).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "{{ .SecurityModulesVersion }}-x" } })
    expect(onChange).toHaveBeenCalledWith("{{ .SecurityModulesVersion }}-x")
    rerender(
      <FormControl
        id="f"
        variable={variable}
        value="{{ .SecurityModulesVersion }}-x"
        onChange={onChange}
      />,
    )
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "{{ .SecurityModulesVersion }}-x",
    )
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
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Clear linked value" }))
    expect(onChange).toHaveBeenCalledWith("")

    rerender(<FormControl id="f" variable={variable} value="" onChange={onChange} />)
    const input = screen.getByRole("textbox") as HTMLInputElement
    expect(input.value).toBe("")
    expect(input).toHaveFocus()
  })

  it("shows a disabled linked value as tokens with nothing to click", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="{{ .SecurityModulesVersion }}"
        onChange={vi.fn()}
        disabled
      />,
    )

    expect(screen.getByText("Security Modules Version")).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expectNoRawTemplateText(container)
  })

  it("shows a linked sensitive value as a token too", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar({ sensitive: true })}
        value="{{ .SharedSecret }}"
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: /Shared Secret/ })).toBeInTheDocument()
    expect(container.querySelector('input[type="password"]')).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /Shared Secret/ }))
    expect(container.querySelector('input[type="password"]')).toHaveFocus()
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
        />,
      )

      expect(screen.getByText("Based on DB Host")).toBeInTheDocument()
      expect(container.innerHTML).not.toContain("hunter2")
      expect(container.innerHTML).not.toContain("postgres://")
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
    const { rerender } = render(
      <FormControl id="f" variable={variable} value="" onChange={onChange} onBlur={onBlur} />,
    )

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "{{ .inputs.A }}" } })
    rerender(
      <FormControl
        id="f"
        variable={variable}
        value="{{ .inputs.A }}"
        onChange={onChange}
        onBlur={onBlur}
      />,
    )

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("{{ .inputs.A }}")
    expect(screen.queryByRole("button", { name: "Clear linked value" })).toBeNull()

    fireEvent.blur(screen.getByRole("textbox"))
    expect(onBlur).toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByRole("button", { name: /^A$/ })).toBeInTheDocument()
  })

  it("shows the chip again when the user leaves an expression they opened", () => {
    render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="{{ .SecurityModulesVersion }}"
        resolvedValue="v1.4.0"
        onChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /v1\.4\.0/ }))
    fireEvent.blur(screen.getByRole("textbox"))

    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByRole("button", { name: /v1\.4\.0/ })).toBeInTheDocument()
  })

  it("keeps a textbox when the user leaves a value that is no longer an expression", () => {
    const onChange = vi.fn()
    const variable = stringVar()
    const { rerender } = render(
      <FormControl
        id="f"
        variable={variable}
        value="{{ .SecurityModulesVersion }}"
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /Security Modules Version/ }))
    rerender(<FormControl id="f" variable={variable} value="v2.0.0" onChange={onChange} />)
    fireEvent.blur(screen.getByRole("textbox"))

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("v2.0.0")
  })

  it("keeps a sensitive expression open while focus moves to its show button", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar({ sensitive: true })}
        value="{{ .SharedSecret }}"
        onChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /Shared Secret/ }))
    const input = container.querySelector('input[type="password"]')!
    const showButton = screen.getByRole("button", { name: "Show sensitive input" })
    fireEvent.blur(input, { relatedTarget: showButton })
    expect(container.querySelector('input[type="password"]')).not.toBeNull()

    fireEvent.blur(showButton, { relatedTarget: document.body })
    expect(container.querySelector("input")).toBeNull()
    expect(screen.getByRole("button", { name: /Shared Secret/ })).toBeInTheDocument()
  })

  it("shows a linked list entry as tokens, and removing it still works", () => {
    const variable: BoilerplateVariable = {
      name: "CatalogRepositories",
      type: "list",
      description: "",
    }
    const onChange = vi.fn()
    const value = ["github.com/acme/catalog", "{{ .RepoBaseUrl }}/{{ .InfraModulesRepoName }}"]
    const { container } = render(
      <FormControl id="f" variable={variable} value={value} onChange={onChange} />,
    )

    expect(screen.getByText("github.com/acme/catalog")).toBeInTheDocument()
    expect(screen.getByText("Repo Base URL")).toBeInTheDocument()
    expect(screen.getByText("Infra Modules Repo Name")).toBeInTheDocument()
    expect(container.querySelector(`[title="${value[1]}"]`)).not.toBeNull()
    expectNoRawTemplateText(container)

    fireEvent.click(screen.getAllByTitle("Remove entry")[1]!)
    expect(onChange).toHaveBeenCalledWith(["github.com/acme/catalog"])
  })

  it("shows a linked map key and a linked map value as tokens", () => {
    const variable: BoilerplateVariable = { name: "DefaultTags", type: "map", description: "" }
    const { container } = render(
      <FormControl
        id="f"
        variable={variable}
        onChange={vi.fn()}
        value={{ "{{ .OrgNamePrefix }}:Team": "DevOps", Owner: "{{ .TeamEmail }}" }}
      />,
    )

    expect(screen.getByText("Org Name Prefix")).toBeInTheDocument()
    expect(screen.getByText("DevOps")).toBeInTheDocument()
    expect(screen.getByText("Team Email")).toBeInTheDocument()
    expectNoRawTemplateText(container)
  })

  it("shows linked fields of a structured map entry as tokens", () => {
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
      />,
    )

    expect(screen.getByText("security")).toBeInTheDocument()
    expect(screen.getByText("Email Domain Name")).toBeInTheDocument()
    expect(screen.getByText("Security")).toBeInTheDocument()
    expectNoRawTemplateText(container)
  })

  it("shows what a linked value comes to when it is known, with the expression on hover", () => {
    const { container } = render(
      <FormControl
        id="f"
        variable={stringVar()}
        value='{{ if eq .Environment "prod" }}large{{ else }}small{{ end }}'
        resolvedValue="small"
        onChange={vi.fn()}
      />,
    )

    const chip = screen.getByRole("button", { name: "small" })
    expect(chip.id).toBe("f-ModuleVersion")
    expect(screen.queryByText(/Based on/)).toBeNull()
    expect(
      container.querySelector(
        `[title='{{ if eq .Environment "prod" }}large{{ else }}small{{ end }}']`,
      ),
    ).not.toBeNull()
    expectNoRawTemplateText(container)
  })

  it.each([
    ["not resolved yet", undefined],
    ["unresolvable", "{{ .outputs.account.id }}"],
    ["empty", ""],
  ])("keeps the tokens when what the value comes to is %s", (_case, resolvedValue) => {
    render(
      <FormControl
        id="f"
        variable={stringVar()}
        value="{{ .outputs.account.id }}"
        resolvedValue={resolvedValue}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: /Set automatically/ })).toBeInTheDocument()
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
        />,
      )

      expect(screen.getByText("Based on DB Password")).toBeInTheDocument()
      expect(container.innerHTML).not.toContain("hunter2")
    },
  )

  it("shows what linked list entries come to", () => {
    const variable: BoilerplateVariable = { name: "Repos", type: "list", description: "" }
    const { container } = render(
      <FormControl
        id="f"
        variable={variable}
        value={["github.com/acme/catalog", "github.com/{{ .ProjectName }}/modules"]}
        resolvedValue={["github.com/acme/catalog", "github.com/acme/modules"]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText("github.com/acme/modules")).toBeInTheDocument()
    expect(screen.queryByText("Project Name")).toBeNull()
    expectNoRawTemplateText(container)
  })

  it("shows what linked map keys and values come to", () => {
    const variable: BoilerplateVariable = { name: "DefaultTags", type: "map", description: "" }
    const { container } = render(
      <FormControl
        id="f"
        variable={variable}
        value={{ "{{ .OrgNamePrefix }}:Team": "DevOps", Owner: "{{ .TeamEmail }}" }}
        resolvedValue={{ "acme:Team": "DevOps", Owner: "ops@acme.io" }}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText("acme:Team")).toBeInTheDocument()
    expect(screen.getByText("ops@acme.io")).toBeInTheDocument()
    expectNoRawTemplateText(container)
  })

  it("shows what linked structured map fields come to", () => {
    const variable: BoilerplateVariable = {
      name: "Accounts",
      type: "map",
      description: "",
      schema: { email: "string", name: "string" },
    }
    render(
      <FormControl
        id="f"
        variable={variable}
        onChange={vi.fn()}
        value={{ security: { email: "security@{{ .EmailDomainName }}", name: "Security" } }}
        resolvedValue={{ security: { email: "security@acme.io", name: "Security" } }}
      />,
    )

    expect(screen.getByText("security@acme.io")).toBeInTheDocument()
    expect(screen.queryByText("Email Domain Name")).toBeNull()
  })

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
