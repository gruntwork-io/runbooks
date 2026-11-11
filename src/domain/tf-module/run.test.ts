import { describe, it, expect } from "bun:test"
import { appliedResources, commandLine, moduleOutputs, plannedResources, uiEvents } from "./run.ts"

describe("plannedResources", () => {
  it("keeps managed changes and what an existing resource was, hiding what's unknown or sensitive", () => {
    const plan = {
      resource_changes: [
        {
          address: "data.google_organization.org[0]",
          mode: "data",
          type: "google_organization",
          name: "org",
          change: { actions: ["read"], after: {} },
        },
        {
          address: "terraform_data.group",
          mode: "managed",
          type: "terraform_data",
          name: "group",
          change: {
            actions: ["create"],
            after: { input: { name: "platform", token: "x" }, triggers_replace: null },
            after_unknown: { id: true, input: {}, output: true },
            after_sensitive: { input: { token: true } },
          },
        },
        {
          address: "terraform_data.old",
          mode: "managed",
          type: "terraform_data",
          name: "old",
          change: {
            actions: ["delete", "create"],
            before: { input: "a", token: "t" },
            before_sensitive: { token: true },
            after: { input: "b" },
          },
        },
        {
          address: "terraform_data.same",
          mode: "managed",
          type: "terraform_data",
          name: "same",
          change: { actions: ["no-op"], after: {} },
        },
      ],
    }
    expect(plannedResources(plan)).toEqual([
      {
        address: "terraform_data.group",
        type: "terraform_data",
        name: "group",
        action: "create",
        properties: {
          input: { name: "platform", token: { hidden: "sensitive" } },
          triggers_replace: null,
          id: { hidden: "known after apply" },
          output: { hidden: "known after apply" },
        },
      },
      {
        address: "terraform_data.old",
        type: "terraform_data",
        name: "old",
        action: "replace",
        properties: { input: "b" },
        before: { input: "a", token: { hidden: "sensitive" } },
      },
    ])
  })
})

describe("appliedResources", () => {
  it("reads the root module's resources and its children's", () => {
    const state = {
      values: {
        root_module: {
          resources: [
            {
              address: "terraform_data.group",
              mode: "managed",
              type: "terraform_data",
              name: "group",
              values: { id: "abc" },
              sensitive_values: {},
            },
          ],
          child_modules: [
            {
              resources: [
                {
                  address: "module.x.terraform_data.y",
                  mode: "managed",
                  type: "terraform_data",
                  name: "y",
                  values: { secret: "s" },
                  sensitive_values: { secret: true },
                },
              ],
            },
          ],
        },
      },
    }
    expect(appliedResources(state)).toEqual([
      {
        address: "terraform_data.group",
        type: "terraform_data",
        name: "group",
        properties: { id: "abc" },
      },
      {
        address: "module.x.terraform_data.y",
        type: "terraform_data",
        name: "y",
        properties: { secret: { hidden: "sensitive" } },
      },
    ])
  })
})

describe("moduleOutputs", () => {
  it("orders outputs as the module declares them, and writes non-strings as JSON", () => {
    const outputs = {
      url: { value: "https://example.com/g", sensitive: false },
      ids: { value: ["a", "b"], sensitive: false },
      secret: { value: "shh", sensitive: true },
    }
    expect(moduleOutputs(outputs, ["secret", "url"])).toEqual([
      { name: "secret", value: "shh", sensitive: true },
      { name: "url", value: "https://example.com/g", sensitive: false },
      { name: "ids", value: '["a","b"]', sensitive: false },
    ])
  })
})

describe("uiEvents", () => {
  const line = (message: object) => JSON.stringify(message)
  const hook = { resource: { addr: "terraform_data.group" } }

  it("turns apply hooks into resource progress, with OpenTofu's message for the log", () => {
    expect(
      uiEvents(
        line({ "@message": "terraform_data.group: Creating...", type: "apply_start", hook }),
      ),
    ).toEqual([
      { kind: "log", line: "terraform_data.group: Creating..." },
      { kind: "resource", address: "terraform_data.group", progress: "working" },
    ])
    expect(
      uiEvents(
        line({
          "@message": "terraform_data.group: Creation complete after 2s",
          type: "apply_complete",
          hook: { ...hook, elapsed_seconds: 2 },
        }),
      ),
    ).toContainEqual({
      kind: "resource",
      address: "terraform_data.group",
      progress: "done",
      elapsedSeconds: 2,
    })
  })

  it("logs a diagnostic's detail as an error, and a line that isn't JSON as it is", () => {
    expect(
      uiEvents(
        line({
          "@level": "error",
          "@message": "Error: Invalid value",
          type: "diagnostic",
          diagnostic: { detail: "The id must be an email address." },
        }),
      ),
    ).toEqual([
      { kind: "log", line: "Error: Invalid value", level: "error" },
      { kind: "log", line: "The id must be an email address.", level: "error" },
    ])
    expect(uiEvents("plain text")).toEqual([{ kind: "log", line: "plain text" }])
  })
})

describe("commandLine", () => {
  it("runs the command in its folder, quoting what a shell would split", () => {
    expect(
      commandLine("/Users/sam/My Repos/live", "terragrunt", [
        "plan",
        "-out=/tmp/plan.tfplan",
        "--non-interactive",
        "it's",
      ]),
    ).toBe(
      "$ cd '/Users/sam/My Repos/live' && terragrunt plan -out=/tmp/plan.tfplan --non-interactive 'it'\\''s'",
    )
  })
})
