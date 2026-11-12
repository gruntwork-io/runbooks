import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import YAML from "yaml"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { checkSimulation, readModuleDeclarations, recordModule } from "./module.ts"
import type { RunContext } from "./run.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  run(Effect.provide(effect, NodeFileSystemLive) as Effect.Effect<A, E, never>)

let repo: string
let moduleDir: string

const write = (relative: string, text: string) => {
  const file = path.join(repo, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const GOOGLE_INCLUDE = `
lookups:
  google:
    auth: GoogleAuth
    people:
      request: { url: "https://admin.googleapis.com/admin/directory/v1/users?query={{ .query }}" }
      rows: users
      fields: { value: primaryEmail, label: name.fullName }
checks:
  google:
    auth: GoogleAuth
    apiEnabled:
      params: [api]
      request: { url: "https://serviceusage.googleapis.com/v1/projects/{{ .auth.project }}/services/{{ .params.api }}" }
      expect: { path: state, equals: ENABLED }
      message: "{{ .params.api }} is off."
`

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "lookups-"))
  fs.mkdirSync(path.join(repo, ".git"))
  moduleDir = path.join(repo, "modules", "google-group")
  write("runbooks/_includes/google.yml", GOOGLE_INCLUDE)
  write(
    "modules/google-group/runbook_block.yml",
    `
include:
  - ../../runbooks/_includes/google.yml
preflight:
  - check: google.apiEnabled
    with: { api: admin.googleapis.com }
variables:
  owners:
    lookup: { from: google.people }
`,
  )
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

describe("readModuleDeclarations", () => {
  it("loads a module's uses with the definitions it includes", async () => {
    const declarations = await live(readModuleDeclarations(moduleDir))
    expect(declarations.problems).toEqual([])
    expect(Object.keys(declarations.definitions.lookups)).toEqual(["google.people"])
    expect(declarations.uses).toEqual([
      { where: "variables.owners.lookup", use: { from: "google.people", with: {} } },
    ])
  })

  it("refuses an include outside the repository", async () => {
    write("modules/google-group/runbook_block.yml", "include: [../../../elsewhere.yml]\n")
    const declarations = await live(readModuleDeclarations(moduleDir))
    expect(declarations.problems.map((p) => p.message)).toEqual([
      expect.stringContaining("is outside the repository"),
    ])
  })

  it("reports a use of a lookup no file defines", async () => {
    write(
      "modules/google-group/runbook_block.yml",
      "variables:\n  owners:\n    lookup: { from: google.people }\n",
    )
    const declarations = await live(readModuleDeclarations(moduleDir))
    expect(declarations.problems.map((p) => p.message)).toEqual([
      expect.stringContaining(
        "variables.owners.lookup uses google.people, which isn't defined or included",
      ),
    ])
  })
})

describe("simulation.yml", () => {
  const context = (answers: Record<string, unknown>): RunContext => ({
    definitions: { groups: {}, lookups: {}, checks: {} },
    inputs: {},
    auth: () => ({ project: "p" }),
    send: async (request) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(answers[new URL(request.url).hostname]),
    }),
  })

  it("records a sample of each use and keeps the file's other scenarios", async () => {
    write(
      "modules/google-group/simulation.yml",
      "# Canned answers\nscenarios:\n  happy-path:\n    label: Happy path\n",
    )
    const declarations = await live(readModuleDeclarations(moduleDir))
    const result = await live(
      recordModule(
        moduleDir,
        declarations,
        {
          ...context({
            "admin.googleapis.com": {
              users: [{ primaryEmail: "real@acme.com", name: { fullName: "Real" } }],
            },
            "serviceusage.googleapis.com": { state: "ENABLED", name: "projects/1" },
          }),
          definitions: declarations.definitions,
        },
        { keepValues: false },
      ),
    )
    expect(result.failures).toEqual([])
    expect(result.text.startsWith("# Canned answers")).toBe(true)
    expect(YAML.parse(result.text).scenarios).toEqual({
      "happy-path": { label: "Happy path" },
      recorded: {
        label: "Recorded",
        description: "Answers recorded from the real APIs, with placeholder values.",
        responses: {
          "google.people": [
            {
              status: 200,
              body: {
                users: [{ primaryEmail: "user-1@example.com", name: { fullName: "label-1" } }],
              },
            },
          ],
          "google.apiEnabled": [
            { with: { api: "admin.googleapis.com" }, status: 200, body: { state: "ENABLED" } },
          ],
        },
      },
    })

    write("modules/google-group/simulation.yml", result.text)
    expect(await live(checkSimulation(moduleDir, declarations))).toEqual([])
  })

  it("reports recorded answers the declarations no longer read", async () => {
    write(
      "modules/google-group/simulation.yml",
      `
scenarios:
  recorded:
    responses:
      google.people:
        - status: 200
          body: { users: [{ primaryEmail: a@example.com, displayName: A }] }
      google.gone:
        - { status: 200, body: {} }
`,
    )
    const declarations = await live(readModuleDeclarations(moduleDir))
    expect((await live(checkSimulation(moduleDir, declarations))).map((p) => p.message)).toEqual([
      expect.stringContaining(
        "no row has name.fullName (field label). The path is wrong, or the API changed.",
      ),
      expect.stringContaining("the module defines no lookup or check google.gone"),
    ])
  })
})
