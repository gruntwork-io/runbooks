import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SECURITY_TESTS } from "./security-tests.ts"

const ROOT = path.resolve(import.meta.dir, "..")

/** Whether `source` declares a test or suite with exactly this name, in any quote style. */
const declares = (source: string, name: string) =>
  [`"${name}"`, `'${name}'`, `\`${name}\``].some((quoted) => source.includes(quoted))

describe("security regression tests", () => {
  for (const { guard, tests } of SECURITY_TESTS) {
    it(`still exist in today's tree: ${guard.split(":")[0]}`, () => {
      const missing = tests.flatMap(({ file, names }) => {
        const source = readFileSync(path.join(ROOT, file), "utf8")
        return names.filter((name) => !declares(source, name)).map((name) => `${file}: ${name}`)
      })
      expect(missing).toEqual([])
    })
  }

  it("name each test once", () => {
    const all = SECURITY_TESTS.flatMap(({ tests }) =>
      tests.flatMap(({ file, names }) => names.map((name) => `${file}: ${name}`)),
    )
    expect(all.length).toBe(new Set(all).size)
  })
})
