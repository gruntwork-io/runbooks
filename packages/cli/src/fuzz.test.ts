/**
 * The fuzz generator, ported with today's tests (`cli/test/fuzz.test.ts`).
 * Each draw is seeded, so a range test covers many draws and still gives
 * the same result on every run.
 */
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { Effect, Random, Result } from "effect"
import { fuzzValue } from "./fuzz.ts"
import type { FuzzConfig } from "./testFile.ts"

/** Seeds per range test. */
const SAMPLES = 40
const SEEDS = Array.from({ length: SAMPLES }, (_, i) => i)
/** Seeds for a test that every value in a range comes up. */
const MANY = Array.from({ length: 400 }, (_, i) => i)
/** The whole numbers lo..hi. */
const whole = (lo: number, hi: number) =>
  new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i))

const drawn = (config: FuzzConfig, seed: number | string = 0) =>
  Effect.runSync(Effect.result(fuzzValue(config).pipe(Random.withSeed(seed))))

/** The value drawn with `seed`; the test fails if the settings draw nothing. */
function draw(config: FuzzConfig, seed: number | string = 0): unknown {
  const result = drawn(config, seed)
  if (Result.isFailure(result)) throw new Error(`no value: ${result.failure.message}`)
  return result.success
}

const text = (config: FuzzConfig, seed?: number) => draw(config, seed) as string
const number = (config: FuzzConfig, seed?: number) => draw(config, seed) as number

/** Why the settings draw nothing: a `FuzzError`'s message. */
function refusal(config: FuzzConfig): string {
  const result = drawn(config)
  if (Result.isSuccess(result)) throw new Error(`drew ${JSON.stringify(result.success)}`)
  expect(result.failure._tag).toBe("FuzzError")
  return result.failure.message
}

describe("a fuzz value", () => {
  it("is the same for the same seed, and differs across seeds", () => {
    const config: FuzzConfig = { type: "string", minLength: 5, maxLength: 20 }
    expect(draw(config, "abc")).toBe(draw(config, "abc"))
    expect(new Set(SEEDS.map((seed) => draw(config, seed))).size).toBe(SAMPLES)
  })
})

describe("string", () => {
  it("has the length asked for, or one in minLength..maxLength", () => {
    for (const seed of SEEDS) {
      expect(text({ type: "string", length: 7 }, seed)).toHaveLength(7)
      const ranged = text({ type: "string", minLength: 3, maxLength: 5 }, seed)
      expect(ranged.length).toBeGreaterThanOrEqual(3)
      expect(ranged.length).toBeLessThanOrEqual(5)
    }
  })

  it("is 8 to 18 letters and digits by default, or with each setting left empty", () => {
    const lengths = new Set<number>()
    for (const seed of MANY)
      for (const config of [
        { type: "string" },
        { type: "string", length: null, minLength: null, maxLength: null },
      ] satisfies ReadonlyArray<FuzzConfig>) {
        const value = text(config, seed)
        expect(value).toMatch(/^[A-Za-z0-9]{8,18}$/u)
        lengths.add(value.length)
      }
    expect(lengths).toEqual(whole(8, 18))
  })

  it("takes a prefix and a suffix around its length", () => {
    expect(text({ type: "string", length: 4, prefix: "p-", suffix: "-s" })).toMatch(
      /^p-[A-Za-z0-9]{4}-s$/u,
    )
    expect(text({ type: "string", length: 0, prefix: "p-" })).toBe("p-")
  })

  it("keeps a lone maxLength below the default minLength (8)", () => {
    for (const seed of SEEDS) expect(text({ type: "string", maxLength: 3 }, seed)).toHaveLength(3)
  })

  it("draws spaces and special characters only when asked", () => {
    const all = SEEDS.map((seed) =>
      text({ type: "string", length: 40, includeSpaces: true, includeSpecialChars: true }, seed),
    ).join("")
    expect(all).toContain(" ")
    expect(all).toMatch(/[!@#$%^&*()\-_=+[\]{}|;:,.<>?]/u)
    for (const seed of SEEDS) expect(text({ type: "string", length: 40 }, seed)).toMatch(/^\w+$/u)
  })

  it("refuses a maxLength below its minLength", () => {
    expect(refusal({ type: "string", minLength: 5, maxLength: 3 })).toBe(
      "fuzz string: maxLength (3) is less than minLength (5)",
    )
  })
})

describe("int and float", () => {
  it("stay in min..max, both included", () => {
    const ints = new Set<number>()
    for (const seed of SEEDS) {
      const int = number({ type: "int", min: 5, max: 7 }, seed)
      expect(Number.isInteger(int)).toBe(true)
      expect(int).toBeGreaterThanOrEqual(5)
      expect(int).toBeLessThanOrEqual(7)
      ints.add(int)
      const float = number({ type: "float", min: 0, max: 1 }, seed)
      expect(float).toBeGreaterThanOrEqual(0)
      expect(float).toBeLessThanOrEqual(1)
    }
    expect(ints).toEqual(new Set([5, 6, 7]))
  })

  it("keep a lone min: max is min + 100", () => {
    for (const type of ["int", "float"] as const)
      for (const seed of SEEDS) {
        const value = number({ type, min: 200 }, seed)
        expect(value).toBeGreaterThanOrEqual(200)
        expect(value).toBeLessThanOrEqual(300)
      }
  })

  it("keep a lone max: min is 0, or max - 100 when max is 0 or less", () => {
    const zeroes = new Set<number>()
    for (const seed of SEEDS) {
      const positive = number({ type: "int", max: 50 }, seed)
      expect(positive).toBeGreaterThanOrEqual(0)
      expect(positive).toBeLessThanOrEqual(50)
      const negative = number({ type: "int", max: -5 }, seed)
      expect(negative).toBeGreaterThanOrEqual(-105)
      expect(negative).toBeLessThanOrEqual(-5)
      const zero = number({ type: "int", max: 0 }, seed)
      expect(zero).toBeGreaterThanOrEqual(-100)
      expect(zero).toBeLessThanOrEqual(0)
      zeroes.add(zero)
    }
    // A lone max of 0 still varies.
    expect(zeroes.size).toBeGreaterThan(1)
  })

  it("are 0..100 with no bounds, or with each bound left empty", () => {
    for (const type of ["int", "float"] as const)
      for (const seed of SEEDS)
        for (const config of [
          { type },
          { type, min: null, max: null },
        ] satisfies ReadonlyArray<FuzzConfig>) {
          const value = number(config, seed)
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(100)
        }
  })

  it("give exactly min when max equals it", () => {
    for (const seed of SEEDS) {
      expect(draw({ type: "int", min: 7, max: 7 }, seed)).toBe(7)
      expect(draw({ type: "float", min: 2.5, max: 2.5 }, seed)).toBe(2.5)
    }
  })

  it("refuse a max below min", () => {
    expect(refusal({ type: "int", min: 10, max: 5 })).toBe(
      "fuzz int: max (5) is less than min (10)",
    )
    expect(refusal({ type: "float", min: 10, max: 5 })).toBe(
      "fuzz float: max (5) is less than min (10)",
    )
  })

  it("int: narrows fractional bounds to the whole numbers between them, and refuses when there are none", () => {
    const seen = new Set(SEEDS.map((seed) => number({ type: "int", min: 0.5, max: 2.5 }, seed)))
    expect(seen).toEqual(new Set([1, 2]))
    expect(refusal({ type: "int", min: 0.2, max: 0.8 })).toBe(
      "fuzz int: no integer between min (0.2) and max (0.8)",
    )
  })
})

describe("bool and enum", () => {
  it("bool: is true or false, and both come up", () => {
    expect(new Set(SEEDS.map((seed) => draw({ type: "bool" }, seed)))).toEqual(
      new Set([true, false]),
    )
  })

  it("enum: is one of the options, and each comes up", () => {
    const options = ["red", "green", "blue"]
    expect(new Set(SEEDS.map((seed) => draw({ type: "enum", options }, seed)))).toEqual(
      new Set(options),
    )
  })

  it("enum: refuses no options", () => {
    for (const options of [undefined, null, []])
      expect(refusal({ type: "enum", ...(options === undefined ? {} : { options }) })).toBe(
        "fuzz enum: options lists nothing to choose from",
      )
  })
})

describe("email, url and uuid", () => {
  it("email: is a lowercase address at an example domain, or at its domain", () => {
    for (const seed of SEEDS)
      for (const config of [
        { type: "email" },
        { type: "email", domain: null },
        { type: "email", domain: "" },
      ] satisfies ReadonlyArray<FuzzConfig>)
        expect(text(config, seed)).toMatch(
          /^[a-z0-9]{6,10}@(example\.com|test\.org|demo\.net|sample\.io)$/u,
        )
    expect(text({ type: "email", domain: "acme.test" })).toMatch(/^[a-z0-9]{6,10}@acme\.test$/u)
  })

  it("url: is an https URL with a lowercase path", () => {
    for (const seed of SEEDS) {
      const url = new URL(text({ type: "url", domain: "acme.test" }, seed))
      expect(url.protocol).toBe("https:")
      expect(url.hostname).toBe("acme.test")
      expect(url.pathname).toMatch(/^\/[a-z0-9]{4,8}$/u)
    }
  })

  it("uuid: is a version 4 UUID", () => {
    for (const seed of SEEDS)
      expect(text({ type: "uuid" }, seed)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
  })
})

describe("date and timestamp", () => {
  it("date: is YYYY-MM-DD in minDate..maxDate", () => {
    const days = new Set<string>()
    for (const seed of SEEDS) {
      const day = text({ type: "date", minDate: "2024-01-01", maxDate: "2024-01-05" }, seed)
      expect(day).toMatch(/^2024-01-0[1-5]$/u)
      days.add(day)
    }
    expect(days.size).toBe(5)
  })

  it("date and timestamp: fall within the last year by default", () => {
    const now = Date.now()
    const yearAgo = now - 366 * 24 * 60 * 60 * 1000
    let oldest = now
    for (const seed of MANY) {
      const day = Date.parse(text({ type: "date" }, seed))
      oldest = Math.min(oldest, day)
      expect(day).toBeGreaterThanOrEqual(yearAgo)
      expect(day).toBeLessThanOrEqual(now)
      const stamp = text({ type: "timestamp" }, seed)
      expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(yearAgo)
      expect(Date.parse(stamp)).toBeLessThanOrEqual(now + 1000)
    }
    // The whole year, not only its end.
    expect(oldest).toBeLessThan(now - 360 * 24 * 60 * 60 * 1000)
  })

  it("writes each token of a format once, never inside the year", () => {
    const day = { minDate: "2026-03-10", maxDate: "2026-03-10" }
    expect(draw({ type: "date", ...day, format: "2006-01-02" })).toBe("2026-03-10")
    expect(draw({ type: "date", ...day, format: "01/02/2006" })).toBe("03/10/2026")
    const at = "2019-07-18T09:30:45Z"
    const stamp = (format: string) => draw({ type: "timestamp", minDate: at, maxDate: at, format })
    expect(stamp("2006-01-02T15:04:05Z07:00")).toBe(at)
    expect(stamp("2006-01-02T15:04:05-07:00")).toBe("2019-07-18T09:30:45+00:00")
    expect(stamp("2006-01-02T15:04:05-0700")).toBe("2019-07-18T09:30:45+0000")
    expect(stamp("2006-01-02T15:04:05Z0700")).toBe("2019-07-18T09:30:45Z")
    expect(stamp("2006-01-02 15:04:05 MST")).toBe("2019-07-18 09:30:45 UTC")
  })

  it("formats in UTC, whatever the machine's zone", () => {
    // The zone is fixed when the process starts, so draw in one west of UTC,
    // where the local day of a UTC midnight is the day before.
    const script = `
      import { Effect } from "effect"
      import { fuzzValue } from ${JSON.stringify(path.join(import.meta.dirname, "fuzz.ts"))}
      console.log(JSON.stringify(Effect.runSync(Effect.all([
        fuzzValue({ type: "date", minDate: "2026-03-10", maxDate: "2026-03-10", format: "01/02/2006" }),
        fuzzValue({ type: "timestamp", minDate: "2019-07-18T02:30:45Z", maxDate: "2019-07-18T02:30:45Z", format: "02 15:04" }),
      ]))))
    `
    const ran = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      cwd: import.meta.dirname,
      env: { PATH: process.env["PATH"] ?? "", TZ: "America/Los_Angeles" },
    })
    expect({ status: ran.status, stderr: ran.stderr }).toEqual({ status: 0, stderr: "" })
    expect(JSON.parse(ran.stdout)).toEqual(["03/10/2026", "18 02:30"])
  })

  it("refuses a minDate after maxDate, or one that is not a date", () => {
    expect(refusal({ type: "date", minDate: "2024-02-01", maxDate: "2024-01-01" })).toBe(
      "fuzz date: minDate (2024-02-01T00:00:00.000Z) is after maxDate (2024-01-01T00:00:00.000Z)",
    )
    expect(refusal({ type: "timestamp", maxDate: "last tuesday" })).toBe(
      'fuzz timestamp: maxDate "last tuesday" is not a date such as 2024-01-31 or 2024-01-31T09:30:00Z',
    )
    // JavaScript reads these as dates; today's runner, and the docs, take neither form.
    for (const minDate of ["2024", "March 5, 2024"])
      expect(refusal({ type: "date", minDate })).toBe(
        `fuzz date: minDate "${minDate}" is not a date such as 2024-01-31 or 2024-01-31T09:30:00Z`,
      )
  })
})

describe("words", () => {
  it("has the count asked for, 2 to 5 by default, or a lone smaller maxWordCount", () => {
    expect(text({ type: "words", wordCount: 4 }).split(" ")).toHaveLength(4)
    expect(text({ type: "words", wordCount: 0 })).toBe("")
    const counts = new Set(MANY.map((seed) => text({ type: "words" }, seed).split(" ").length))
    expect(counts).toEqual(whole(2, 5))
    for (const seed of SEEDS)
      expect(text({ type: "words", maxWordCount: 1 }, seed)).toMatch(/^[a-z]+$/u)
  })

  it("refuses a maxWordCount below its minWordCount", () => {
    expect(refusal({ type: "words", minWordCount: 4, maxWordCount: 2 })).toBe(
      "fuzz words: maxWordCount (2) is less than minWordCount (4)",
    )
  })
})

describe("list and map", () => {
  const items = (config: FuzzConfig, seed?: number) => JSON.parse(text(config, seed)) as unknown

  it("list: is JSON text of `count` text items", () => {
    expect(items({ type: "list", count: 3 })).toEqual([
      expect.stringMatching(/^\w{5,12}$/u),
      expect.stringMatching(/^\w{5,12}$/u),
      expect.stringMatching(/^\w{5,12}$/u),
    ])
    expect(draw({ type: "list", count: 0 })).toBe("[]")
  })

  it("list: keeps a lone maxCount or maxLength below its default, and a lone minLength above", () => {
    const lengths = new Set<number>()
    for (const seed of SEEDS) {
      expect(items({ type: "list", maxCount: 1, maxLength: 3 }, seed)).toEqual([
        expect.stringMatching(/^\w{3}$/u),
      ])
      for (const item of items({ type: "list", minLength: 20 }, seed) as string[]) {
        expect(item.length).toBeGreaterThanOrEqual(20)
        expect(item.length).toBeLessThanOrEqual(27)
        lengths.add(item.length)
      }
    }
    expect(lengths.size).toBeGreaterThan(1)
  })

  it("map: is JSON text of `count` entries of text", () => {
    const entries = Object.entries(items({ type: "map", count: 2 }) as object)
    expect(entries).toHaveLength(2)
    for (const [name, value] of entries) {
      expect(name).toMatch(/^\w{5,12}$/u)
      expect(value).toMatch(/^\w{5,12}$/u)
    }
    expect(draw({ type: "map", count: 0 })).toBe("{}")
    for (const seed of SEEDS)
      expect(
        Object.values(items({ type: "map", maxCount: 1, maxLength: 3 }, seed) as object),
      ).toEqual([expect.stringMatching(/^\w{3}$/u)])
  })

  it("map with a schema: is a map of entries, each a map of the schema's names to text", () => {
    const value = draw({ type: "map", count: 2, schema: ["alpha", "beta"] }) as Record<
      string,
      Record<string, string>
    >
    expect(Object.keys(value)).toHaveLength(2)
    for (const entry of Object.values(value)) expect(Object.keys(entry)).toEqual(["alpha", "beta"])
    const lengths = new Set<number>()
    for (const seed of MANY)
      for (const entry of Object.values(
        draw({ type: "map", count: 1, schema: ["a"] }, seed) as Record<
          string,
          Record<string, string>
        >,
      ))
        for (const field of Object.values(entry)) {
          expect(field).toMatch(/^\w+$/u)
          lengths.add(field.length)
        }
    expect(lengths).toEqual(whole(5, 15))
    expect(draw({ type: "map", count: 0, schema: ["a"] })).toEqual({})
    // A schema name is an entry's own key, never its prototype.
    const own = draw({ type: "map", count: 1, schema: ["__proto__"] }) as Record<string, object>
    const [entry] = Object.values(own)
    expect(Object.keys(entry ?? {})).toEqual(["__proto__"])
  })

  it("refuse a maximum below its minimum", () => {
    for (const type of ["list", "map"] as const) {
      expect(refusal({ type, minCount: 3, maxCount: 1 })).toBe(
        `fuzz ${type}: maxCount (1) is less than minCount (3)`,
      )
      expect(refusal({ type, minLength: 6, maxLength: 3 })).toBe(
        `fuzz ${type}: maxLength (3) is less than minLength (6)`,
      )
    }
  })
})
