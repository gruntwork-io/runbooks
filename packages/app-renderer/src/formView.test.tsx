import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { useSyncExternalStore } from "react"
import type { BlockView, FieldView } from "@runbooks/core/protocol"
import type { FieldValue } from "./formView.tsx"
import { installDom } from "./testDom.ts"

// The form as a person uses it: they type and click in a jsdom page, and the
// test reads the controls and what the form sent. React DOM and Testing
// Library load once the page is there (testDom.ts).
const uninstall = installDom()
afterAll(uninstall)
const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react")
const { userEvent } = await import("@testing-library/user-event")
const { FormView } = await import("./formView.tsx")
afterEach(cleanup)

type TreeNode = FieldView["description"]
type Section = NonNullable<BlockView["sections"]>[number]
const NO_DESCRIPTION: TreeNode = { type: "root", children: [] }
const described = (text: string): TreeNode => ({
  type: "root",
  children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
})

const field = (
  name: string,
  type: FieldView["type"],
  rest: Partial<Omit<FieldView, "name" | "type">> = {},
): FieldView => ({
  name,
  type,
  description: NO_DESCRIPTION,
  required: false,
  sensitive: false,
  readOnly: false,
  validations: [],
  reviewed: false,
  unresolved: [],
  ...rest,
})
const shown = (value: FieldValue) => ({ _tag: "Shown" as const, value })

/**
 * An engine that answers late: it holds each `SetValues` the form sends
 * until the test answers it, and the form shows the fields the test last
 * published, as the window's store does.
 */
function lateEngine(first: ReadonlyArray<FieldView>, sections: ReadonlyArray<Section> = []) {
  let fields = first
  const listeners = new Set<() => void>()
  const sent: Array<Readonly<Record<string, FieldValue>>> = []
  const waiting: Array<(effect: Effect.Effect<void>) => void> = []
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const enter = (values: Readonly<Record<string, FieldValue>>) =>
    Effect.callback<void>((resume) => {
      sent.push(values)
      waiting.push(resume)
    })
  function Page() {
    const now = useSyncExternalStore(subscribe, () => fields)
    return (
      <FormView
        fields={now}
        sections={sections}
        enter={enter}
        runbook="/work/runbook.mdx"
        session="s-1"
      />
    )
  }
  const settle = () =>
    new Promise((done) => {
      setTimeout(done, 0)
    })
  return {
    sent,
    waiting: () => waiting.length,
    page: () => render(<Page />),
    /** Answers the oldest `SetValues` not yet answered. */
    answer: () =>
      act(async () => {
        waiting.shift()?.(Effect.void)
        await settle()
      }),
    /** Ends the oldest `SetValues` not yet answered with a defect, as a call that dies does. */
    die: () =>
      act(async () => {
        waiting.shift()?.(Effect.die(new Error("the engine's call died")))
        await settle()
      }),
    /** Publishes a view of the fields, as a `GetBlock` answer does. */
    show: (next: ReadonlyArray<FieldView>) =>
      act(async () => {
        fields = next
        for (const listener of listeners) listener()
        await settle()
      }),
  }
}

const box = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement

describe("FormView", () => {
  it("draws a field's label, whether it is required, its description and its error", () => {
    lateEngine([
      field("GitHubOrgName", "string", {
        required: true,
        description: described("The org that holds the repos."),
        error: "GitHub Org Name is required.",
      }),
      field("ProjectName", "string"),
    ]).page()
    expect(box("GitHub Org Name*").value).toBe("")
    expect(box("Project Name").value).toBe("")
    const org = screen.getByTestId("field-GitHubOrgName")
    expect(org.textContent).toContain("The org that holds the repos.")
    expect(org.textContent).toContain("GitHub Org Name is required.")
    expect(screen.getByTestId("field-ProjectName").textContent).toBe("Project Name")
  })

  it("sends each change as its type takes it, and shows what the engine holds", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("Name", "string", { value: shown("web") }),
      field("Replicas", "int", { value: shown(2) }),
      field("Ratio", "float"),
      field("AddAdditionalCommonVariables", "bool"),
      field("DefaultRegion", "enum", {
        options: ["us-east-1", "eu-west-1"],
        optionLabels: { "eu-west-1": "Ireland" },
        value: shown("us-east-1"),
      }),
    ])
    engine.page()
    expect(box("Name").value).toBe("web")
    const replicas = screen.getByRole("spinbutton", { name: "Replicas" }) as HTMLInputElement
    expect(replicas.value).toBe("2")
    const ratio = screen.getByRole("spinbutton", { name: "Ratio" }) as HTMLInputElement
    expect(ratio.value).toBe("")
    const region = screen.getByRole("combobox", { name: "Default Region" }) as HTMLSelectElement
    expect(region.value).toBe("us-east-1")
    expect([...region.options].map((option) => option.text)).toEqual(["us-east-1", "Ireland"])

    await user.type(box("Name"), "s")
    await user.clear(replicas)
    await user.type(replicas, "3")
    await user.type(ratio, "0.5")
    // user-event drops a trailing zero after a decimal point, which a person can type.
    fireEvent.change(ratio, { target: { value: "0.50" } })
    await user.click(screen.getByRole("checkbox", { name: "Add Additional Common Variables" }))
    await user.selectOptions(region, "Ireland")
    // A number box sends a number once what it holds reads as one, and nothing ("") when emptied.
    const last = (name: string) => engine.sent.filter((values) => name in values).at(-1)?.[name]
    expect(
      ["Name", "Replicas", "Ratio", "AddAdditionalCommonVariables", "DefaultRegion"].map(last),
    ).toEqual(["webs", 3, 0.5, true, "eu-west-1"])
    expect(engine.sent.slice(0, 3)).toEqual([{ Name: "webs" }, { Replicas: "" }, { Replicas: 3 }])
    expect(engine.sent.every((values) => typeof (values["Ratio"] ?? 0) === "number")).toBe(true)
    // While the box holds the value sent, it keeps the text typed for it.
    expect(ratio.value).toBe("0.50")
    expect(replicas.value).toBe("3")
  })

  it("keeps every keystroke and the cursor while the engine answers late and its views lag", async () => {
    const user = userEvent.setup()
    const name = (value?: string) =>
      field("Name", "string", value === undefined ? {} : { value: shown(value) })
    const engine = lateEngine([name()])
    engine.page()
    await user.type(box("Name"), "abc")
    // An answer and a view from before the last keystrokes.
    await engine.answer()
    await engine.show([name("a")])
    expect(box("Name").value).toBe("abc")
    await user.keyboard("{ArrowLeft}X")
    expect(box("Name").value).toBe("abXc")
    expect(box("Name").selectionStart).toBe(3)
    await engine.answer()
    await engine.answer()
    await engine.answer()
    await engine.show([name("ab")])
    await user.keyboard("Y")
    expect(box("Name").value).toBe("abXYc")
    expect(box("Name").selectionStart).toBe(4)
    while (engine.waiting() > 0) await engine.answer()
    // Every value is answered, and the view, from before the last, still lags.
    await engine.show([name("abXc")])
    expect(box("Name").value).toBe("abXYc")
    await engine.show([name("abXYc")])
    expect(box("Name").value).toBe("abXYc")
    expect(box("Name").selectionStart).toBe(4)
    expect(engine.sent.map((values) => values["Name"])).toEqual(["a", "ab", "abc", "abXc", "abXYc"])
    // Once the engine caught up, the field shows what it holds.
    await engine.show([name("set elsewhere")])
    expect(box("Name").value).toBe("set elsewhere")
  })

  it("keeps a value typed back to one the engine showed until the engine answers it", async () => {
    const user = userEvent.setup()
    const name = (value: string) => field("Name", "string", { value: shown(value) })
    const engine = lateEngine([name("a")])
    engine.page()
    await user.type(box("Name"), "b")
    await engine.answer()
    await user.keyboard("{Backspace}")
    // The engine still holds "a" while "a" is unanswered: the view shows "a" from before "ab".
    await engine.show([name("a")])
    await engine.show([name("ab")])
    expect(box("Name").value).toBe("a")
    await engine.answer()
    await engine.show([name("a")])
    expect(box("Name").value).toBe("a")
    expect(engine.sent).toEqual([{ Name: "ab" }, { Name: "a" }])
  })

  it("shows the engine's value again once a value it never answered has ended", async () => {
    const user = userEvent.setup()
    const name = (value: string) => field("Name", "string", { value: shown(value) })
    const engine = lateEngine([name("a")])
    engine.page()
    await user.type(box("Name"), "b")
    await engine.die()
    await engine.show([name("ab")])
    await engine.show([name("set elsewhere")])
    expect(box("Name").value).toBe("set elsewhere")
  })

  it("shows what the engine holds once a field the person emptied is empty, or turns read-only", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("Name", "string", { value: shown("a") }),
      field("Region", "string"),
    ])
    engine.page()
    await user.clear(box("Name"))
    await user.type(box("Region"), "x")
    while (engine.waiting() > 0) await engine.answer()
    // The engine holds no value in an emptied field, and imports the region from another block.
    await engine.show([
      field("Name", "string"),
      field("Region", "string", { readOnly: true, value: shown("eu-west-1") }),
    ])
    expect(box("Region (read-only)").value).toBe("eu-west-1")
    await engine.show([field("Name", "string", { value: shown("b") }), field("Region", "string")])
    expect([box("Name").value, box("Region").value]).toEqual(["b", ""])
  })

  it("shows a read-only field's value, and the engine's error on it, in a control that can't change", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("Region", "string", { readOnly: true, value: shown("eu-west-1") }),
      field("Replicas", "int", {
        readOnly: true,
        value: shown(0),
        error: "Replicas must be at least 1.",
      }),
      field("Public", "bool", { readOnly: true, required: true, value: shown(true) }),
    ])
    engine.page()
    const region = box("Region (read-only)")
    expect(region.value).toBe("eu-west-1")
    expect(region.disabled).toBe(true)
    await user.type(region, "x")
    expect(region.value).toBe("eu-west-1")
    const replicas = screen.getByRole("spinbutton", { name: "Replicas (read-only)" })
    expect((replicas as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId("field-Replicas").textContent).toContain(
      "Replicas must be at least 1.",
    )
    const visible = screen.getByRole("checkbox", { name: "Public (read-only)" }) as HTMLInputElement
    expect([visible.checked, visible.disabled]).toEqual([true, true])
    await user.click(visible)
    expect(engine.sent).toEqual([])
  })

  it("never shows a sensitive field's value, and sends what the person types in it", async () => {
    const user = userEvent.setup()
    const hidden = { _tag: "Hidden" as const }
    const engine = lateEngine([
      field("DbPassword", "string", { sensitive: true, value: hidden }),
      field("Pin", "int", { sensitive: true }),
      field("Secrets", "map", { sensitive: true, value: hidden }),
    ])
    const { container } = engine.page()
    const password = screen.getByLabelText("DB Password") as HTMLInputElement
    expect([password.type, password.value, password.placeholder]).toEqual([
      "password",
      "",
      "Hidden: it is sensitive.",
    ])
    await user.type(password, "hu")
    await user.type(screen.getByLabelText("Pin"), "42")
    while (engine.waiting() > 0) await engine.answer()
    await engine.show([
      field("DbPassword", "string", { sensitive: true, value: hidden }),
      field("Pin", "int", { sensitive: true, value: hidden }),
      field("Secrets", "map", { sensitive: true, value: hidden }),
    ])
    expect(password.value).toBe("hu")
    expect(engine.sent).toEqual([
      { DbPassword: "h" },
      { DbPassword: "hu" },
      { Pin: 4 },
      { Pin: 42 },
    ])
    expect(screen.getByTestId("field-Secrets").textContent).toBe(
      "SecretsHidden: it is sensitive. The window can't enter a sensitive map yet.",
    )
    expect(container.querySelectorAll("input").length).toBe(2)
  })

  it("shows an enum's empty option as chosen when the field holds it", () => {
    lateEngine([field("Suffix", "enum", { options: ["", "-dev"], value: shown("") })]).page()
    const suffix = screen.getByRole("combobox", { name: "Suffix" }) as HTMLSelectElement
    expect([...suffix.options].map((option) => option.text)).toEqual(["", "-dev"])
    expect(suffix.value).toBe("")
  })

  it("chooses an enum's option, and says so when the field holds none of them", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("Size", "enum", { options: ["s", "m"] }),
      field("Tier", "enum", { options: ["free", "paid"], value: shown("legacy") }),
    ])
    engine.page()
    const size = screen.getByRole("combobox", { name: "Size" }) as HTMLSelectElement
    expect([size.value, size.selectedOptions[0]?.text]).toEqual(["", "Select…"])
    const tier = screen.getByRole("combobox", { name: "Tier" }) as HTMLSelectElement
    expect([...tier.options].map((option) => [option.text, option.disabled])).toEqual([
      ["legacy", true],
      ["free", false],
      ["paid", false],
    ])
    expect(tier.value).toBe("legacy")
    await user.selectOptions(size, "m")
    expect(engine.sent).toEqual([{ Size: "m" }])
    expect(size.value).toBe("m")
  })
})

describe("FormView's lists and maps", () => {
  const within = (name: string) => screen.getByTestId(`field-${name}`)
  const entries = (name: string) =>
    [...within(name).querySelectorAll("li")].map((li) => li.textContent)

  it("adds a list's entries with Enter or Add, trimmed, and removes them", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([field("AllowedIPs", "list", { value: shown(["10.0.0.0/8"]) })])
    engine.page()
    const entry = screen.getByPlaceholderText("Type an entry and press Enter...")
    expect(screen.getByLabelText("Allowed IPs")).toBe(entry)
    await user.type(entry, " 10.1.0.0/16 {Enter}")
    expect(engine.sent).toEqual([{ AllowedIPs: ["10.0.0.0/8", "10.1.0.0/16"] }])
    await user.type(entry, "   ")
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.type(entry, "10.2.0.0/16")
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(entries("AllowedIPs")).toEqual([
      "10.0.0.0/8Remove",
      "10.1.0.0/16Remove",
      "10.2.0.0/16Remove",
    ])
    expect(entry).toHaveProperty("value", "")
    await user.click(screen.getByRole("button", { name: "Remove 10.1.0.0/16" }))
    expect(engine.sent).toEqual([
      { AllowedIPs: ["10.0.0.0/8", "10.1.0.0/16"] },
      { AllowedIPs: ["10.0.0.0/8", "10.1.0.0/16", "10.2.0.0/16"] },
      { AllowedIPs: ["10.0.0.0/8", "10.2.0.0/16"] },
    ])
  })

  it("chooses a list's options with a box each, kept in the options' order", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("AllowedRegions", "list", {
        options: ["us-east-1", "eu-west-1", "ap-south-1"],
        optionLabels: { "eu-west-1": "Ireland" },
        value: shown(["eu-west-1"]),
      }),
    ])
    engine.page()
    const group = screen.getByRole("group", { name: "Allowed Regions" })
    const choice = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement
    expect(group.contains(choice("Ireland"))).toBe(true)
    expect(
      [choice("us-east-1"), choice("Ireland"), choice("ap-south-1")].map((input) => input.checked),
    ).toEqual([false, true, false])
    await user.click(choice("ap-south-1"))
    await user.click(choice("us-east-1"))
    await user.click(choice("Ireland"))
    expect(engine.sent).toEqual([
      { AllowedRegions: ["eu-west-1", "ap-south-1"] },
      { AllowedRegions: ["us-east-1", "eu-west-1", "ap-south-1"] },
      { AllowedRegions: ["us-east-1", "ap-south-1"] },
    ])
  })

  it("shows a chosen value the options don't list, keeps it, and removes it when unticked", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("Regions", "list", {
        options: ["us-east-1", "eu-west-1"],
        value: shown(["ap-south-1", "us-east-1"]),
      }),
    ])
    engine.page()
    const choice = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement
    const unlisted = choice("ap-south-1 (not an option)")
    expect(unlisted.checked).toBe(true)
    await user.click(choice("eu-west-1"))
    await user.click(unlisted)
    expect(engine.sent).toEqual([
      { Regions: ["us-east-1", "eu-west-1", "ap-south-1"] },
      { Regions: ["us-east-1", "eu-west-1"] },
    ])
  })

  it("adds a map's entry once it has a key and a value, trimmed, and removes it", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([field("Tags", "map", { value: shown({ team: "core" }) })])
    engine.page()
    const key = screen.getByPlaceholderText("Key")
    const value = screen.getByPlaceholderText("Value")
    await user.type(key, " env ")
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(engine.sent).toEqual([])
    await user.type(value, " prod ")
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(entries("Tags")).toEqual(["team: coreRemove", "env: prodRemove"])
    expect([key, value].map((input) => (input as HTMLInputElement).value)).toEqual(["", ""])
    await user.click(screen.getByRole("button", { name: "Remove team" }))
    expect(engine.sent).toEqual([
      { Tags: { team: "core", env: "prod" } },
      { Tags: { env: "prod" } },
    ])
  })

  it("adds a structured map's entry from its schema's fields, each kept as text", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("AWSAccounts", "map", {
        schema: { email: "string", id: "int", enabled: "bool" },
        schemaInstanceLabel: "AWS Account Name",
      }),
    ])
    engine.page()
    await user.click(screen.getByRole("button", { name: "Add" }))
    const save = screen.getByRole("button", { name: "Save Entry" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await user.type(screen.getByRole("textbox", { name: /AWS Account Name/ }), " prod ")
    await user.type(screen.getByRole("textbox", { name: /^email\b/i }), "ops@example.com")
    await user.type(screen.getByRole("spinbutton", { name: "id (int)" }), "123")
    expect(
      (screen.getByRole("combobox", { name: "enabled (bool)" }) as HTMLSelectElement).value,
    ).toBe("false")
    await user.click(save)
    expect(screen.queryByRole("button", { name: "Save Entry" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.type(screen.getByRole("textbox", { name: /AWS Account Name/ }), "dev")
    await user.selectOptions(screen.getByRole("combobox", { name: "enabled (bool)" }), "true")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("button", { name: "Save Entry" })).toBeNull()
    expect(engine.sent).toEqual([
      { AWSAccounts: { prod: { email: "ops@example.com", id: "123", enabled: "false" } } },
    ])
    expect(entries("AWSAccounts")).toEqual([
      "prod: email: ops@example.com, id: 123, enabled: falseRemove",
    ])
    expect(
      within("AWSAccounts").contains(screen.getByRole("group", { name: "AWS Accounts" })),
    ).toBe(true)
  })

  it("enters a tuple's elements in position order, each as its type takes it", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("Endpoint", "list", { schema: { "1": "int", "0": "string", "2": "bool" } }),
    ])
    engine.page()
    const group = screen.getByRole("group", { name: "Endpoint" })
    expect([...group.querySelectorAll("label")].map((label) => label.textContent)).toEqual([
      "Enter a string",
      "Enter an integer",
      "Enter a boolean",
    ])
    await user.type(screen.getByRole("textbox", { name: "Enter a string" }), "db")
    await user.type(screen.getByRole("spinbutton", { name: "Enter an integer" }), "5432")
    await user.selectOptions(screen.getByRole("combobox", { name: "Enter a boolean" }), "true")
    expect(engine.sent.at(-1)).toEqual({ Endpoint: ["db", 5432, true] })
    expect(engine.sent[0]).toEqual({ Endpoint: ["d", "", false] })
  })

  it("shows in a tuple's int element the whole number it sends", async () => {
    const engine = lateEngine([field("Endpoint", "list", { schema: { "0": "int" } })])
    engine.page()
    const port = screen.getByRole("spinbutton", { name: "Enter an integer" }) as HTMLInputElement
    fireEvent.change(port, { target: { value: "1.5" } })
    expect(engine.sent).toEqual([{ Endpoint: [1] }])
    expect(port.value).toBe("1")
  })

  it("shows a read-only tuple's and options list's values in controls that can't change", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("Endpoint", "list", {
        readOnly: true,
        schema: { "0": "string" },
        value: shown(["db"]),
      }),
      field("Regions", "list", { readOnly: true, options: ["us-east-1"], value: shown([]) }),
    ])
    engine.page()
    const host = screen.getByRole("textbox", { name: "Enter a string" }) as HTMLInputElement
    const region = screen.getByRole("checkbox", { name: "us-east-1" }) as HTMLInputElement
    expect([host.value, host.disabled, region.disabled]).toEqual(["db", true, true])
    await user.type(host, "x")
    await user.click(region)
    expect(engine.sent).toEqual([])
  })

  it("shows a read-only list's and map's entries with nothing to add or remove", () => {
    lateEngine([
      field("AllowedIPs", "list", { readOnly: true, value: shown(["10.0.0.0/8"]) }),
      field("Tags", "map", { readOnly: true, value: shown({ team: "core" }) }),
      field("AWSAccounts", "map", {
        readOnly: true,
        schema: { email: "string" },
        value: shown({ prod: { email: "ops@example.com" } }),
      }),
    ]).page()
    expect(entries("AllowedIPs")).toEqual(["10.0.0.0/8"])
    expect(entries("Tags")).toEqual(["team: core"])
    expect(entries("AWSAccounts")).toEqual(["prod: email: ops@example.com"])
    expect(screen.queryAllByRole("button")).toEqual([])
    expect(screen.queryAllByRole("textbox")).toEqual([])
  })
})

describe("FormView's sections and resets", () => {
  it("draws each section under its heading, one that starts folded opening and closing from it", async () => {
    const user = userEvent.setup()
    lateEngine(
      [
        field("Name", "string"),
        field("Port", "int", { section: "Network" }),
        field("Retries", "int", { section: "Advanced", error: "Retries must be at least 1." }),
        field("Timeout", "int", { section: "Advanced" }),
      ],
      [
        { name: "Network", collapsed: false },
        { name: "Advanced", collapsed: true },
      ],
    ).page()
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Network",
      "Advanced A field in it has an error.",
    ])
    expect(screen.queryByRole("button", { name: "Network" })).toBeNull()
    expect(screen.getByRole("spinbutton", { name: "Port" })).toBeTruthy()
    const advanced = screen.getByRole("button", { name: "Advanced" })
    expect(advanced.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("spinbutton", { name: "Retries" })).toBeNull()
    await user.click(advanced)
    expect(advanced.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByTestId("field-Retries").textContent).toContain("Retries must be at least 1.")
    expect(screen.getByRole("spinbutton", { name: "Timeout" })).toBeTruthy()
    expect(screen.getAllByRole("heading")[1]?.textContent).toBe("Advanced")
    await user.click(advanced)
    expect(screen.queryByRole("spinbutton", { name: "Timeout" })).toBeNull()
  })

  it("offers a Reset that sends a field's default while the field holds another value", async () => {
    const user = userEvent.setup()
    const engine = lateEngine([
      field("BucketName", "string", { default: "logs", value: shown("logs") }),
      field("Replicas", "int", { default: 2 }),
      field("Region", "string", {
        default: "us-east-1",
        readOnly: true,
        value: shown("eu-west-1"),
      }),
      field("Owner", "string", { value: shown("me") }),
    ])
    engine.page()
    const reset = (label: string) =>
      screen.queryByRole("button", { name: `Reset ${label} to its default` })
    // An emptied field holds no value, which is not its default.
    expect([reset("Bucket Name"), reset("Region"), reset("Owner")]).toEqual([null, null, null])
    expect(reset("Replicas")).not.toBeNull()
    await user.type(box("Bucket Name"), "-old")
    await user.click(reset("Bucket Name") as HTMLElement)
    expect(box("Bucket Name").value).toBe("logs")
    expect(reset("Bucket Name")).toBeNull()
    await user.click(reset("Replicas") as HTMLElement)
    expect((screen.getByRole("spinbutton", { name: "Replicas" }) as HTMLInputElement).value).toBe(
      "2",
    )
    expect(engine.sent.slice(-2)).toEqual([{ BucketName: "logs" }, { Replicas: 2 }])
  })
})
