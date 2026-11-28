/**
 * Inputs in the window, end to end: each of Inputs' test runbooks
 * (blocks/inputs/testdata) opened in place and trusted through the trust
 * prompt, then run in the window as its runbook_test.yml runs it: the
 * values typed into the forms' fields, each form submitted, and the blocks
 * that read them run, with each block's status and outputs as the window
 * shows them. The old app's Inputs checks (kitchen-sink, demo3, next-app and
 * homepage-demo) run on these runbooks.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 */
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

const testdata = (name: string) =>
  path.join(import.meta.dirname, "..", "blocks", "inputs", "testdata", name)

/** Trusts the runbook through the trust prompt. */
async function trust(page: Page) {
  const prompt = page.getByRole("region", { name: "Trust this runbook" })
  await prompt.getByRole("button", { name: "I trust this runbook" }).click()
  await expect(prompt).toHaveCount(0)
}

/** Runs a task block and waits for it to be done. */
async function run(block: Locator) {
  await block.getByRole("button", { name: "Run" }).click()
  await expect(block.locator(".block-status")).toHaveText("Done")
}

/** The outputs a task block shows, by name, in the order shown. */
async function expectOutputs(block: Locator, outputs: Readonly<Record<string, string>>) {
  await expect(block.getByLabel("Outputs").locator("dt")).toHaveText(Object.keys(outputs))
  await expect(block.getByLabel("Outputs").locator("dd")).toHaveText(Object.values(outputs))
}

/** The blocks a blocked block waits for, each with what it waits for that block to do. */
async function expectWaitingFor(block: Locator, waiting: ReadonlyArray<string>) {
  await expect(block.locator(".block-blockers").getByRole("listitem")).toHaveText([...waiting])
}

test.describe("Inputs in the window", () => {
  test("end-to-end: the form in its order, the engine's error at once, Submit; deploy reads it, greet its own form", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("end-to-end")] })
    const config = page.locator("#runbook-block-config")
    const deploy = page.locator("#runbook-block-deploy")
    const greet = page.locator("#runbook-block-greet")
    await trust(page)

    // Name's `order` is lowest, so it comes first.
    await expect(config.locator(".form-label")).toHaveText(["Name*", "Region", "Count"])
    await expect(config.getByRole("combobox", { name: "Region" })).toHaveValue("us-east-1")
    await expect(config.getByRole("spinbutton", { name: "Count" })).toHaveValue("2")
    // The engine's error shows before the person touches the field, and the form can't be submitted.
    await expect(config.locator(".block-status")).toHaveText("Needs input: Name")
    await expect(config.getByTestId("field-Name").locator(".form-error")).toHaveText(
      "Name is required",
    )
    await expect(config.getByRole("button", { name: "Submit" })).toHaveCount(0)
    await expectWaitingFor(deploy, ["config to have its values"])
    await expect(deploy.getByRole("button", { name: "Run" })).toHaveCount(0)

    await config.getByRole("textbox", { name: "Name" }).fill("web")
    await config.getByRole("combobox", { name: "Region" }).selectOption("eu-west-1")
    await expect(config.locator(".form-error")).toHaveCount(0)
    await expect(config.locator(".block-status")).toHaveText("Ready")
    await config.getByRole("button", { name: "Submit" }).click()
    await expect(config.locator(".block-status")).toHaveText("Done")
    // A submitted form offers Submit again, and Undo Submit.
    await expect(config.locator(".block-actions").getByRole("button")).toHaveText([
      "Submit",
      "Undo Submit",
    ])

    await expect(deploy.locator(".block-status")).toHaveText("Ready")
    await run(deploy)
    await expectOutputs(deploy, { seen: "web/eu-west-1/2" })

    // greet's own form draws inside it, with its default and no Submit.
    const who = greet.getByRole("region", { name: "<Inputs> block" })
    await expect(who.getByRole("textbox", { name: "Who" })).toHaveValue("world")
    await expect(greet.getByRole("button", { name: "Submit" })).toHaveCount(0)
    await run(greet)
    await expectOutputs(greet, { said: "hello world" })
  })

  test("end-to-end: every keystroke typed fast is kept, and a reader gets all of it", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("end-to-end")] })
    const config = page.locator("#runbook-block-config")
    const deploy = page.locator("#runbook-block-deploy")
    await trust(page)

    const name = config.getByRole("textbox", { name: "Name" })
    const typed = "web-frontend-in-eu-west-1-for-the-payments-team-0123456789"
    await name.pressSequentially(typed.slice(0, 1))
    const submit = config.getByRole("button", { name: "Submit" })
    await expect(submit).toBeVisible()
    // The rest with no delay between keys, then Submit at once, while the engine may still be answering them.
    await name.pressSequentially(typed.slice(1))
    await submit.click()
    await expect(name).toHaveValue(typed)
    await expect(config.locator(".block-status")).toHaveText("Done")

    await run(deploy)
    await expectOutputs(deploy, { seen: `${typed}/us-east-1/2` })
  })

  test("path: forms read from a folder's boilerplate.yaml and from a file", async ({ launch }) => {
    const { page } = await launch({ args: [testdata("path")] })
    const network = page.locator("#runbook-block-network")
    const tags = page.locator("#runbook-block-tags")
    const describe = page.locator("#runbook-block-describe")
    await trust(page)

    await expect(network.getByRole("textbox", { name: "Cidr Block" })).toHaveValue("10.0.0.0/16")
    await expect(network.locator(".form-description")).toHaveText("The VPC's CIDR block")
    await expect(tags.locator(".form-description")).toHaveText("Who owns what this makes")
    await expectWaitingFor(describe, ["tags to have its values"])

    await network.getByRole("button", { name: "Submit" }).click()
    await expect(network.locator(".block-status")).toHaveText("Done")
    await tags.getByRole("textbox", { name: "Owner" }).fill("platform")
    await tags.getByRole("button", { name: "Submit" }).click()
    await expect(tags.locator(".block-status")).toHaveText("Done")

    await run(describe)
    await expectOutputs(describe, { summary: "platform:10.0.0.0/16" })
  })

  test("prefilled: the runbook's values over a shared file's defaults, a locked field read-only", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("prefilled")] })
    const settings = page.locator("#runbook-block-settings")
    const show = page.locator("#runbook-block-show")
    await trust(page)

    await expect(settings.getByRole("textbox", { name: "Region" })).toHaveValue("eu-west-1")
    const environment = settings.getByRole("combobox", { name: "Environment (read-only)" })
    await expect(environment).toHaveValue("production")
    await expect(environment).toBeDisabled()

    await settings.getByRole("button", { name: "Submit" }).click()
    await expect(settings.locator(".block-status")).toHaveText("Done")
    await run(show)
    await expectOutputs(show, { where: "production@eu-west-1" })
  })

  test("prefilled: a reader gets the form's starting values until its first Submit, then each change as it is typed", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("prefilled")] })
    const settings = page.locator("#runbook-block-settings")
    const show = page.locator("#runbook-block-show")
    const region = settings.getByRole("textbox", { name: "Region" })
    await trust(page)

    await region.fill("ap-south-1")
    await run(show)
    await expectOutputs(show, { where: "production@eu-west-1" })

    await settings.getByRole("button", { name: "Submit" }).click()
    await expect(settings.locator(".block-status")).toHaveText("Done")
    await run(show)
    await expectOutputs(show, { where: "production@ap-south-1" })

    await region.fill("us-west-2")
    await run(show)
    await expectOutputs(show, { where: "production@us-west-2" })
  })

  test("all-types: a control for each type, with its default and description; the sensitive field is a password box", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("all-types")] })
    const form = page.locator("#runbook-block-all_types")
    const show = page.locator("#runbook-block-show")
    const field = (name: string) => form.getByTestId(`field-${name}`)
    await trust(page)

    await expect(form.locator(".form-description")).toHaveText([
      "A plain string with a default",
      "This field is required",
      "Must be a valid email address",
      "An integer input",
      "A decimal input",
      "A boolean toggle",
      "Pick an environment",
      "A dynamic list of items",
      "Pick any regions",
      "A key-value map",
      "A sensitive password field",
    ])
    await expect(form.getByRole("textbox", { name: "Plain String" })).toHaveValue("hello world")
    await expect(form.getByRole("textbox", { name: "Required String" })).toHaveValue("")
    await expect(form.getByRole("textbox", { name: "Email Field" })).toHaveValue("user@example.com")
    await expect(form.getByRole("spinbutton", { name: "Int Field" })).toHaveValue("42")
    await expect(form.getByRole("spinbutton", { name: "Float Field" })).toHaveValue("0.5")
    await expect(form.getByRole("checkbox", { name: "Bool Field" })).toBeChecked()
    await expect(form.getByRole("combobox", { name: "Enum Field" })).toHaveValue("dev")
    await expect(field("list_field").getByRole("listitem")).toHaveCount(0)
    // An options list is a check box for each option.
    const choices = form.getByRole("group", { name: "Choices Field" }).getByRole("checkbox")
    await expect(choices).toHaveCount(3)
    await expect(choices.nth(0)).toBeChecked()
    await expect(choices.nth(1)).not.toBeChecked()
    await expect(choices.nth(2)).not.toBeChecked()
    await expect(field("map_field").getByRole("listitem")).toHaveCount(0)

    // The sensitive field holds its default, which the window never shows, and has no Show toggle.
    const secret = form.getByRole("textbox", { name: "Secret Field" })
    await expect(secret).toHaveAttribute("type", "password")
    await expect(secret).toHaveValue("")
    await expect(secret).toHaveAttribute("placeholder", "Hidden: it is sensitive.")
    await expect(field("secret_field").getByRole("button")).toHaveCount(0)

    await expect(form.locator(".block-status")).toHaveText("Needs input: required_string")
    await expectWaitingFor(show, ["all_types to have its values"])
  })

  test("all-types: a value entered in each control, then Submit; show reads each", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("all-types")] })
    const form = page.locator("#runbook-block-all_types")
    const show = page.locator("#runbook-block-show")
    const field = (name: string) => form.getByTestId(`field-${name}`)
    await trust(page)

    await form.getByRole("textbox", { name: "Required String" }).fill("given")
    const email = form.getByRole("textbox", { name: "Email Field" })
    await email.fill("not an address")
    await expect(field("email_field").locator(".form-error")).toBeVisible()
    await expect(form.getByRole("button", { name: "Submit" })).toHaveCount(0)
    await email.fill("ops@example.com")
    await expect(field("email_field").locator(".form-error")).toHaveCount(0)
    await form.getByRole("spinbutton", { name: "Int Field" }).fill("7")
    await form.getByRole("spinbutton", { name: "Float Field" }).fill("2.25")
    await form.getByRole("checkbox", { name: "Bool Field" }).uncheck()
    await form.getByRole("combobox", { name: "Enum Field" }).selectOption("prod")

    const list = field("list_field")
    await list.getByRole("textbox").fill("a")
    await list.getByRole("textbox").press("Enter")
    await list.getByRole("textbox").fill("b")
    await list.getByRole("button", { name: "Add" }).click()
    await expect(list.getByRole("listitem").locator("span")).toHaveText(["a", "b"])
    // What is chosen keeps the options' order, not the order ticked.
    const choices = form.getByRole("group", { name: "Choices Field" })
    await choices.getByRole("checkbox", { name: "ap-south-1" }).check()
    await choices.getByRole("checkbox", { name: "eu-west-1" }).check()
    const map = field("map_field")
    await map.getByRole("textbox", { name: "Map Field" }).fill("team")
    await map.getByRole("textbox", { name: "Value" }).fill("platform")
    await map.getByRole("button", { name: "Add" }).click()
    await form.getByRole("textbox", { name: "Secret Field" }).fill("hunter22")

    await form.getByRole("button", { name: "Submit" }).click()
    await expect(form.locator(".block-status")).toHaveText("Done")
    await run(show)
    await expectOutputs(show, {
      plain: "hello world",
      required: "given",
      email: "ops@example.com",
      int: "7",
      float: "2.25",
      bool: "false",
      enum: "prod",
      list: '["a","b"]',
      choices: '["us-east-1","eu-west-1","ap-south-1"]',
      map: '{"team":"platform"}',
      secret_length: "8",
    })
  })

  test("merge: a reader of two forms gets the later form's value for a field both have", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("merge")] })
    const defaults = page.locator("#runbook-block-defaults")
    const overrides = page.locator("#runbook-block-overrides")
    const merged = page.locator("#runbook-block-merged")
    await trust(page)

    await expect(defaults.getByRole("textbox", { name: "Color" })).toHaveValue("blue")
    await expect(overrides.getByRole("textbox", { name: "Size" })).toHaveValue("large")
    await defaults.getByRole("textbox", { name: "Size" }).fill("small")
    await defaults.getByRole("button", { name: "Submit" }).click()
    await expect(defaults.locator(".block-status")).toHaveText("Done")
    await overrides.getByRole("button", { name: "Submit" }).click()
    await expect(overrides.locator(".block-status")).toHaveText("Done")

    await run(merged)
    await expectOutputs(merged, { picked: "blue/large" })
  })

  test("embedded: a Command waits for its own form's required field, then runs with it and the defaults", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("embedded")] })
    const createRepo = page.locator("#runbook-block-create_repo")
    const scaffold = page.locator("#runbook-block-scaffold")
    await trust(page)

    const org = createRepo.getByRole("textbox", { name: "GitHub Org Name" })
    await expect(org).toHaveValue("")
    await expect(createRepo.getByRole("textbox", { name: "Repo Name" })).toHaveValue("my-next-app")
    await expectWaitingFor(createRepo, ["repo_inputs to have its values"])
    await expect(createRepo.getByRole("button", { name: "Run" })).toHaveCount(0)
    await org.fill("acme")
    await run(createRepo)
    await expectOutputs(createRepo, { repo: "acme/my-next-app" })

    await expect(scaffold.getByRole("combobox", { name: "Language" })).toHaveValue("TypeScript")
    await expect(scaffold.getByRole("combobox", { name: "Use Tailwind" })).toHaveValue("Yes")
    await expect(scaffold.getByRole("combobox", { name: "Bundler" })).toHaveValue("Turbopack")
    await expect(scaffold.getByRole("textbox", { name: "Import Alias" })).toHaveValue("@/*")
    await expect(scaffold.getByRole("button", { name: "Submit" })).toHaveCount(0)
    await run(scaffold)
    await expectOutputs(scaffold, { options: "TypeScript Yes Turbopack @/*" })
  })
})
