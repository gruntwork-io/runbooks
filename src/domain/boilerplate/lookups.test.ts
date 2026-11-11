import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { readFormLookups } from "./lookups.ts"

let repo: string

const write = (relative: string, text: string) => {
  const file = path.join(repo, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

const read = (yaml: string) => {
  const file = write("runbooks/team/boilerplate.yml", yaml)
  return Effect.runPromise(
    readFormLookups(yaml, file, "boilerplate.yml").pipe(Effect.provide(NodeFileSystemLive)),
  )
}

const GOOGLE = `
lookups:
  google:
    auth: GoogleAuth
    scopes: [https://www.googleapis.com/auth/admin.directory.user.readonly]
    people:
      request: { url: "https://admin.googleapis.com/admin/directory/v1/users?query={{ .query }}" }
      rows: users
      fields: { value: primaryEmail, label: name.fullName }
    me:
      request: { url: "https://admin.googleapis.com/admin/directory/v1/users/me" }
      fields: { value: primaryEmail, label: name.fullName }
`

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "form-lookups-"))
  fs.mkdirSync(path.join(repo, ".git"))
  write("runbooks/_includes/google.yml", GOOGLE)
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

describe("readFormLookups", () => {
  it("has nothing for a boilerplate.yml without lookups", async () => {
    expect(await read("variables:\n  - name: team\n    type: string\n")).toBeUndefined()
  })

  it("reads x-include, and each variable's x-lookup, x-prefill and x-shortcut", async () => {
    const lookups = await read(`
x-include:
  - ../_includes/google.yml
variables:
  - name: owner
    type: string
    x-prefill: { from: google.me }
  - name: members
    type: list
    x-lookup: { from: google.people }
    x-shortcut: { from: google.me, label: 'Add {{ .label }}' }
  - name: team
    type: string
`)
    expect(lookups?.problems).toEqual([])
    expect(Object.keys(lookups!.definitions.lookups).sort()).toEqual(["google.me", "google.people"])
    expect(lookups?.groups).toEqual(["google"])
    expect(lookups?.inputs).toEqual({
      owner: { prefill: { from: "google.me", with: {} } },
      members: {
        lookup: { from: "google.people", with: {} },
        shortcut: { from: "google.me", with: {}, label: "Add {{ .label }}" },
      },
    })
  })

  it("reads x-lookups declared in the file itself", async () => {
    const lookups = await read(`
x-lookups:
  google:
    auth: GoogleAuth
    people:
      request: { url: "https://admin.googleapis.com/admin/directory/v1/users" }
      rows: users
      fields: { value: primaryEmail }
variables:
  - name: owner
    type: string
    x-lookup: { from: google.people }
`)
    expect(lookups?.problems).toEqual([])
    expect(lookups?.inputs.owner?.lookup?.from).toBe("google.people")
  })

  it("names a use of a lookup that isn't defined, and a use that doesn't fit the variable", async () => {
    const lookups = await read(`
x-include:
  - ../_includes/google.yml
variables:
  - name: owner
    type: string
    x-lookup: { from: google.nobody }
  - name: count
    type: int
    x-lookup: { from: google.people }
  - name: members
    type: list
    x-prefill: { from: google.me }
`)
    expect(lookups?.problems).toEqual([
      "boilerplate.yml: variables.count.x-lookup needs a string or list variable, and count is int.",
      "boilerplate.yml: variables.members.x-prefill needs a string variable, and members is list.",
      expect.stringContaining("variables.owner.x-lookup uses google.nobody, which isn't defined"),
    ])
  })

  it("refuses x-checks and x-preflight, which no form block runs", async () => {
    const lookups = await read(`
x-preflight:
  - check: google.apiEnabled
variables:
  - name: owner
    type: string
`)
    expect(lookups?.problems).toContainEqual(
      "boilerplate.yml: x-preflight isn't supported in boilerplate.yml yet: an <Inputs> or <Template> block runs no checks.",
    )
  })

  it("refuses an include outside the repository", async () => {
    const lookups = await read(`
x-include:
  - ../../../elsewhere.yml
variables:
  - name: owner
    type: string
`)
    expect(lookups?.problems).toEqual([expect.stringContaining("is outside the repository")])
  })
})
