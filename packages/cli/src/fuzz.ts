/**
 * A fuzz input's value: drawn at random within its `fuzz` settings in
 * `runbook_test.yml`, as today's runner draws it (`cli/test/fuzz.ts`) and
 * the testing docs describe it. A setting left empty is unset.
 *
 * It draws from the `Random` service and reads the time from `Clock`, so
 * the same seed and time draw the same value.
 */
import { Array as Arr, Clock, DateTime, Effect, Option, Random, Schema } from "effect"
import type { FieldValue } from "@runbooks/blocks-core/form"
import type { FuzzConfig } from "./testFile.ts"

/** Settings that draw nothing, such as a maximum below its minimum. */
export class FuzzError extends Schema.TaggedError<FuzzError>()("FuzzError", {
  message: Schema.String,
}) {}

const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const SPECIAL = "!@#$%^&*()-_=+[]{}|;:,.<>?"
const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
] as const
const DOMAINS = ["example.com", "test.org", "demo.net", "sample.io"] as const

const DAY_MILLIS = 24 * 60 * 60 * 1000

/** A setting, undefined when it is absent or left empty. */
const setting = <K extends keyof FuzzConfig>(
  config: FuzzConfig,
  key: K,
): NonNullable<FuzzConfig[K]> | undefined => config[key] ?? undefined

type Bound =
  | "min"
  | "max"
  | "minLength"
  | "maxLength"
  | "minWordCount"
  | "maxWordCount"
  | "minCount"
  | "maxCount"

const fail = (config: FuzzConfig, problem: string) =>
  Effect.fail(new FuzzError({ message: `fuzz ${config.type}: ${problem}` }))

/**
 * The [lo, hi] a pair of bounds allows. A lone maximum lowers the minimum's
 * default to fit, and the maximum defaults to the minimum plus `span`, so a
 * lone bound is kept. Equal bounds give that one value.
 */
function range(
  config: FuzzConfig,
  minKey: Bound,
  maxKey: Bound,
  defaultMin: number,
  span: number,
): Effect.Effect<readonly [number, number], FuzzError> {
  const max = setting(config, maxKey)
  const lo = setting(config, minKey) ?? (max === undefined ? defaultMin : Math.min(defaultMin, max))
  const hi = max ?? lo + span
  return hi < lo
    ? fail(config, `${maxKey} (${hi}) is less than ${minKey} (${lo})`)
    : Effect.succeed([lo, hi] as const)
}

/** A whole number in a pair of bounds, both included. */
const sizeIn = (
  config: FuzzConfig,
  minKey: Bound,
  maxKey: Bound,
  defaultMin: number,
  span: number,
) =>
  Effect.flatMap(range(config, minKey, maxKey, defaultMin, span), ([lo, hi]) =>
    Random.nextIntBetween(lo, hi),
  )

const charactersFrom = (characters: string, length: number) =>
  Effect.gen(function* () {
    let text = ""
    for (let i = 0; i < length; i++)
      text += characters.charAt(yield* Random.nextIntBetween(0, characters.length - 1))
    return text
  })

const drawString = Effect.fnUntraced(function* (config: FuzzConfig) {
  const length =
    setting(config, "length") ?? (yield* sizeIn(config, "minLength", "maxLength", 8, 10))
  let characters = ALPHANUMERIC
  if (setting(config, "includeSpaces") === true) characters += " "
  if (setting(config, "includeSpecialChars") === true) characters += SPECIAL
  const text = yield* charactersFrom(characters, length)
  return `${setting(config, "prefix") ?? ""}${text}${setting(config, "suffix") ?? ""}`
})

/** min defaults to 0, or to max - 100 for a lone max of 0 or less, which has no floor to keep. */
function numbers(config: FuzzConfig) {
  const max = setting(config, "max")
  return range(config, "min", "max", max !== undefined && max <= 0 ? max - 100 : 0, 100)
}

const drawInt = Effect.fnUntraced(function* (config: FuzzConfig) {
  const [min, max] = yield* numbers(config)
  // Fractional bounds narrow to the whole numbers between them.
  const lo = Math.ceil(min)
  const hi = Math.floor(max)
  if (hi < lo) return yield* fail(config, `no integer between min (${min}) and max (${max})`)
  return yield* Random.nextIntBetween(lo, hi)
})

const drawEnum = Effect.fnUntraced(function* (config: FuzzConfig) {
  const options = setting(config, "options") ?? []
  if (!Arr.isReadonlyArrayNonEmpty(options))
    return yield* fail(config, "options lists nothing to choose from")
  return yield* Random.choice(options)
})

/** Its `domain`, or one of the example domains when it has none. */
const domainOf = (config: FuzzConfig) => {
  const domain = setting(config, "domain")
  return domain === undefined || domain === "" ? Random.choice(DOMAINS) : Effect.succeed(domain)
}

const drawEmail = Effect.fnUntraced(function* (config: FuzzConfig) {
  const local = yield* drawString({ type: "string", minLength: 6, maxLength: 10 })
  return `${local.toLowerCase()}@${yield* domainOf(config)}`
})

const drawUrl = Effect.fnUntraced(function* (config: FuzzConfig) {
  const page = yield* drawString({ type: "string", minLength: 4, maxLength: 8 })
  return `https://${yield* domainOf(config)}/${page.toLowerCase()}`
})

const drawUuid = Effect.gen(function* () {
  const bytes: number[] = []
  for (let i = 0; i < 16; i++) bytes.push(yield* Random.nextIntBetween(0, 255))
  // Version 4, variant 10.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
})

const DATE_FORMS = [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u, /^\d{4}-\d{2}-\d{2}$/u]

/**
 * A `minDate` or `maxDate` as epoch milliseconds, undefined when it is
 * unset or empty. A date-time with no offset is read in the machine's
 * zone, as today's runner reads it.
 */
function instant(
  config: FuzzConfig,
  key: "minDate" | "maxDate",
): Effect.Effect<number | undefined, FuzzError> {
  const text = setting(config, key)
  if (text === undefined || text === "") return Effect.succeed(undefined)
  const parsed = DATE_FORMS.some((form) => form.test(text))
    ? DateTime.make(new Date(text))
    : Option.none()
  return Option.isSome(parsed)
    ? Effect.succeed(DateTime.toEpochMillis(parsed.value))
    : fail(config, `${key} "${text}" is not a date such as 2024-01-31 or 2024-01-31T09:30:00Z`)
}

/** An instant between `minDate` (a year ago) and `maxDate` (now), a whole number of `unit`s past `minDate`. */
const drawInstant = Effect.fnUntraced(function* (config: FuzzConfig, unit: number) {
  const now = yield* Clock.currentTimeMillis
  const min = (yield* instant(config, "minDate")) ?? now - 365 * DAY_MILLIS
  const max = (yield* instant(config, "maxDate")) ?? now
  if (min > max)
    return yield* fail(
      config,
      `minDate (${DateTime.formatIso(DateTime.makeUnsafe(min))}) is after maxDate (${DateTime.formatIso(DateTime.makeUnsafe(max))})`,
    )
  const units = Math.floor((max - min) / unit)
  const offset = units > 0 ? yield* Random.nextIntBetween(0, units) : 0
  return DateTime.makeUnsafe(min + offset * unit)
})

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * `layout` as a Go reference layout, in UTC: 2006 (year), 01 (month), 02
 * (day), 15 (hour), 04 (minute), 05 (second), and the zones Z07:00,
 * -07:00, Z0700, -0700 and MST written as UTC. One pass, longest tokens
 * first, so a value put in is never matched again.
 */
function formatted(instantAt: DateTime.Utc, layout: string): string {
  const parts = DateTime.toPartsUtc(instantAt)
  const tokens: Record<string, string> = {
    "Z07:00": "Z",
    "-07:00": "+00:00",
    Z0700: "Z",
    "-0700": "+0000",
    MST: "UTC",
    "2006": String(parts.year),
    "01": pad(parts.month),
    "02": pad(parts.day),
    "15": pad(parts.hour),
    "04": pad(parts.minute),
    "05": pad(parts.second),
  }
  return layout.replace(
    /Z07:00|-07:00|Z0700|-0700|2006|MST|01|02|15|04|05/gu,
    (token) => tokens[token] ?? token,
  )
}

const drawDate = Effect.fnUntraced(function* (config: FuzzConfig) {
  const at = yield* drawInstant(config, DAY_MILLIS)
  const layout = setting(config, "format")
  return layout === undefined || layout === ""
    ? DateTime.formatIso(at).slice(0, 10)
    : formatted(at, layout)
})

const drawTimestamp = Effect.fnUntraced(function* (config: FuzzConfig) {
  const at = yield* drawInstant(config, 1000)
  const layout = setting(config, "format")
  return layout === undefined || layout === "" ? DateTime.formatIso(at) : formatted(at, layout)
})

const drawWords = Effect.fnUntraced(function* (config: FuzzConfig) {
  const count =
    setting(config, "wordCount") ?? (yield* sizeIn(config, "minWordCount", "maxWordCount", 2, 3))
  const words: string[] = []
  for (let i = 0; i < count; i++) words.push(yield* Random.choice(WORDS))
  return words.join(" ")
})

/** A list of text items, as JSON text: what today's runner gives, and the docs say. */
const drawList = Effect.fnUntraced(function* (config: FuzzConfig) {
  const count = setting(config, "count") ?? (yield* sizeIn(config, "minCount", "maxCount", 2, 3))
  const [minLength, maxLength] = yield* range(config, "minLength", "maxLength", 5, 7)
  const items: string[] = []
  for (let i = 0; i < count; i++)
    items.push(yield* drawString({ type: "string", minLength, maxLength }))
  return JSON.stringify(items)
})

/**
 * Entries of random names: with a `schema`, each a map of its names to
 * text, as a map; without, each text, as JSON text. As today's runner, and
 * the docs.
 */
const drawMap = Effect.fnUntraced(function* (config: FuzzConfig) {
  const count = setting(config, "count") ?? (yield* sizeIn(config, "minCount", "maxCount", 2, 2))
  const key = { type: "string", minLength: 5, maxLength: 12 } as const
  const schema = setting(config, "schema") ?? []
  if (schema.length > 0) {
    const entries: Array<readonly [string, Record<string, string>]> = []
    for (let i = 0; i < count; i++) {
      const name = yield* drawString(key)
      const fields: Array<readonly [string, string]> = []
      for (const field of schema)
        fields.push([field, yield* drawString({ type: "string", minLength: 5, maxLength: 15 })])
      entries.push([name, Object.fromEntries(fields)])
    }
    return Object.fromEntries(entries)
  }
  const [minLength, maxLength] = yield* range(config, "minLength", "maxLength", 5, 7)
  const entries: Array<readonly [string, string]> = []
  for (let i = 0; i < count; i++)
    entries.push([
      yield* drawString(key),
      yield* drawString({ type: "string", minLength, maxLength }),
    ])
  return JSON.stringify(Object.fromEntries(entries))
})

/** A value drawn within `config`, or why its settings draw nothing. */
export function fuzzValue(config: FuzzConfig): Effect.Effect<FieldValue, FuzzError> {
  switch (config.type) {
    case "string":
      return drawString(config)
    case "int":
      return drawInt(config)
    case "float":
      return Effect.flatMap(numbers(config), ([min, max]) => Random.nextBetween(min, max))
    case "bool":
      return Random.nextBoolean
    case "enum":
      return drawEnum(config)
    case "email":
      return drawEmail(config)
    case "url":
      return drawUrl(config)
    case "uuid":
      return drawUuid
    case "date":
      return drawDate(config)
    case "timestamp":
      return drawTimestamp(config)
    case "words":
      return drawWords(config)
    case "list":
      return drawList(config)
    case "map":
      return drawMap(config)
    default: {
      const unhandled: never = config.type
      throw new Error(`Unhandled fuzz type: ${String(unhandled)}`)
    }
  }
}
