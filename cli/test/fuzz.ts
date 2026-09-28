/**
 * Fuzz value generator for test inputs.
 */
import crypto from "node:crypto"
import type { FuzzConfig, InputValue } from "./config.ts"
import { isLiteralInput } from "./config.ts"

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

function randomInt(min: number, max: number): number {
  if (max < min) max = min
  const range = max - min + 1
  const bytes = crypto.randomBytes(4)
  return min + (bytes.readUInt32BE() % range)
}

function randomFloat(min: number, max: number): number {
  const bytes = crypto.randomBytes(4)
  const ratio = bytes.readUInt32BE() / 0xffffffff
  return min + (max - min) * ratio
}

function randomBool(): boolean {
  return crypto.randomBytes(1)[0] % 2 === 1
}

function randomChoice<T>(items: readonly T[]): T {
  return items[randomInt(0, items.length - 1)]
}

// ---------------------------------------------------------------------------
// Character sets
// ---------------------------------------------------------------------------

const ALPHANUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const SPECIAL = "!@#$%^&*()-_=+[]{}|;:,.<>?"
const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo",
  "foxtrot", "golf", "hotel", "india", "juliet",
  "kilo", "lima", "mike", "november", "oscar",
  "papa", "quebec", "romeo", "sierra", "tango",
  "uniform", "victor", "whiskey", "xray", "yankee", "zulu",
] as const

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateFuzzValue(config: FuzzConfig): unknown {
  switch (config.type) {
    case "string": return generateString(config)
    case "int": return generateInt(config)
    case "float": return generateFloat(config)
    case "bool": return randomBool()
    case "enum": return generateEnum(config)
    case "email": return generateEmail(config)
    case "url": return generateURL(config)
    case "uuid": return generateUUID()
    case "date": return generateDate(config)
    case "timestamp": return generateTimestamp(config)
    case "words": return generateWords(config)
    case "list": return generateList(config)
    case "map": return generateMap(config)
    default: throw new Error(`Unknown fuzz type: ${config.type satisfies never}`)
  }
}

type BoundField =
  | "min" | "max"
  | "minLength" | "maxLength"
  | "minWordCount" | "maxWordCount"
  | "minCount" | "maxCount"

// YAML parses an empty value (`max:` or `max: ~`) to null, so a bound is set
// only when it is neither null nor undefined.
function bound(config: FuzzConfig, field: BoundField): number | undefined {
  return config[field] ?? undefined
}

// The [lo, hi] range a pair of optional bounds allows. A lone hi lowers lo's
// default to fit (lo = min(defaultLo, hi)) and hi defaults to lo + span, so a
// lone bound is honored. lo == hi yields that exact value.
function boundedRange(
  config: FuzzConfig,
  minField: BoundField,
  maxField: BoundField,
  defaultLo: number,
  span: number,
): [number, number] {
  const hi = bound(config, maxField)
  const lo = bound(config, minField) ?? (hi === undefined ? defaultLo : Math.min(defaultLo, hi))
  const top = hi ?? lo + span
  if (top < lo) throw new Error(`fuzz ${config.type}: ${maxField} (${top}) is less than ${minField} (${lo})`)
  return [lo, top]
}

function generateString(config: FuzzConfig): string {
  const length = config.length ?? randomInt(...boundedRange(config, "minLength", "maxLength", 8, 10))

  let charset = ALPHANUM
  if (config.includeSpaces) charset += " "
  if (config.includeSpecialChars) charset += SPECIAL

  let result = ""
  for (let i = 0; i < length; i++) {
    result += charset[randomInt(0, charset.length - 1)]
  }

  return (config.prefix ?? "") + result + (config.suffix ?? "")
}

// min defaults to 0 and max to min + 100. Unlike a length or a count, a number
// has no floor, so a lone non-positive max fuzzes over max - 100..max rather
// than collapsing to max.
function numericRange(config: FuzzConfig): [number, number] {
  const max = bound(config, "max")
  return boundedRange(config, "min", "max", max !== undefined && max <= 0 ? max - 100 : 0, 100)
}

function generateInt(config: FuzzConfig): number {
  const [min, max] = numericRange(config)
  return randomInt(min, max)
}

function generateFloat(config: FuzzConfig): number {
  const [min, max] = numericRange(config)
  return randomFloat(min, max)
}

function generateEnum(config: FuzzConfig): string {
  if (!config.options?.length) throw new Error("No enum options provided")
  return randomChoice(config.options)
}

function generateEmail(config: FuzzConfig): string {
  const local = generateString({ type: "string", minLength: 6, maxLength: 10 })
  const domain = config.domain || randomChoice(["example.com", "test.org", "demo.net", "sample.io"])
  return `${local.toLowerCase()}@${domain}`
}

function generateURL(config: FuzzConfig): string {
  const pathPart = generateString({ type: "string", minLength: 4, maxLength: 8 })
  const domain = config.domain || randomChoice(["example.com", "test.org", "demo.net", "sample.io"])
  return `https://${domain}/${pathPart.toLowerCase()}`
}

function generateUUID(): string {
  const bytes = crypto.randomBytes(16)
  // Set version 4 and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function parseDateString(s: string): Date {
  const formats = [
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO
    /^\d{4}-\d{2}-\d{2}$/, // YYYY-MM-DD
  ]
  for (const fmt of formats) {
    if (fmt.test(s)) {
      const d = new Date(s)
      if (!Number.isNaN(d.getTime())) return d
    }
  }
  throw new Error(`Unable to parse date string "${s}"`)
}

function randomTimeInRange(minDate?: string, maxDate?: string, dayPrecision = false): Date {
  const now = new Date()
  const minTime = minDate ? parseDateString(minDate) : new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
  const maxTime = maxDate ? parseDateString(maxDate) : now

  if (minTime > maxTime) throw new Error(`minDate is after maxDate`)

  const unit = dayPrecision ? 24 * 60 * 60 * 1000 : 1000
  const range = Math.floor((maxTime.getTime() - minTime.getTime()) / unit)
  const offset = range > 0 ? randomInt(0, range) : 0
  return new Date(minTime.getTime() + offset * unit)
}

function generateDate(config: FuzzConfig): string {
  const date = randomTimeInRange(config.minDate, config.maxDate, true)
  if (config.format) return formatDate(date, config.format)
  return date.toISOString().slice(0, 10)
}

function generateTimestamp(config: FuzzConfig): string {
  const date = randomTimeInRange(config.minDate, config.maxDate, false)
  if (config.format) return formatDate(date, config.format)
  return date.toISOString()
}

const pad = (n: number) => String(n).padStart(2, "0")

function formatDate(d: Date, fmt: string): string {
  // Go reference-layout tokens: 2006 (year), 01 (month), 02 (day), 15 (hour),
  // 04 (minute) and 05 (second), read in UTC like the default toISOString()
  // output, and the zones Z07:00, -07:00, Z0700, -0700 and MST, written as
  // UTC to match. One pass with the longest tokens first, so an already-
  // substituted value is never re-matched.
  const parts: Record<string, string> = {
    "Z07:00": "Z",
    "-07:00": "+00:00",
    "Z0700": "Z",
    "-0700": "+0000",
    "MST": "UTC",
    "2006": String(d.getUTCFullYear()),
    "01": pad(d.getUTCMonth() + 1),
    "02": pad(d.getUTCDate()),
    "15": pad(d.getUTCHours()),
    "04": pad(d.getUTCMinutes()),
    "05": pad(d.getUTCSeconds()),
  }
  return fmt.replace(/Z07:00|-07:00|Z0700|-0700|2006|MST|01|02|15|04|05/g, (token) => parts[token])
}

function generateWords(config: FuzzConfig): string {
  const count = config.wordCount ?? randomInt(...boundedRange(config, "minWordCount", "maxWordCount", 2, 3))
  const result: string[] = []
  for (let i = 0; i < count; i++) {
    result.push(randomChoice(WORDS))
  }
  return result.join(" ")
}

function generateList(config: FuzzConfig): string {
  const count = config.count ?? randomInt(...boundedRange(config, "minCount", "maxCount", 2, 3))
  const items: string[] = []
  const [minLength, maxLength] = boundedRange(config, "minLength", "maxLength", 5, 7)
  const itemConfig: FuzzConfig = { type: "string", minLength, maxLength }
  for (let i = 0; i < count; i++) {
    items.push(generateString(itemConfig))
  }
  return JSON.stringify(items)
}

function generateMap(config: FuzzConfig): unknown {
  const count = config.count ?? randomInt(...boundedRange(config, "minCount", "maxCount", 2, 2))

  const keyConfig: FuzzConfig = { type: "string", minLength: 5, maxLength: 12 }

  // Schema-based nested maps
  if (config.schema?.length) {
    const result: Record<string, Record<string, string>> = {}
    const valueConfig: FuzzConfig = { type: "string", minLength: 5, maxLength: 15 }
    for (let i = 0; i < count; i++) {
      const key = generateString(keyConfig)
      const nested: Record<string, string> = {}
      for (const field of config.schema) {
        nested[field] = generateString(valueConfig)
      }
      result[key] = nested
    }
    return result
  }

  // Flat map as JSON string
  const result: Record<string, string> = {}
  const [minLength, maxLength] = boundedRange(config, "minLength", "maxLength", 5, 7)
  const valueConfig: FuzzConfig = { type: "string", minLength, maxLength }
  for (let i = 0; i < count; i++) {
    result[generateString(keyConfig)] = generateString(valueConfig)
  }
  return JSON.stringify(result)
}

// ---------------------------------------------------------------------------
// Resolve all test inputs (fuzz + literal)
// ---------------------------------------------------------------------------

export function resolveTestInputs(
  inputs: Record<string, InputValue> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!inputs) return result

  for (const [name, value] of Object.entries(inputs)) {
    if (isLiteralInput(value)) {
      result[name] = value.literal
    } else {
      result[name] = generateFuzzValue(value.fuzz)
    }
  }

  return result
}
