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
    expect(select.selectedOptions[0].disabled).toBe(false)

    fireEvent.change(select, { target: { value: "1.28" } })
    expect(onChange).toHaveBeenCalledWith("1.28")
    // The picked value comes back as a string
    rerender(<FormControl id="f" variable={variable} value="1.28" onChange={onChange} />)
    expect(select.value).toBe("1.28")
    expect(optionLabels()).toEqual(["1.28", "1.29"])
    expect(select.selectedOptions[0].disabled).toBe(false)
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
    expect(select.selectedOptions[0].text).toBe("Select…")

    fireEvent.change(select, { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith("")

    // Once '' is the value, the real blank option is the selected one
    rerender(<FormControl id="f" variable={variable} value="" onChange={onChange} />)
    expect(screen.queryByRole("option", { name: "Select…" })).toBeNull()
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "DEBUG"])
    expect(select.value).toBe("")
    expect(select.selectedOptions[0].disabled).toBe(false)
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
