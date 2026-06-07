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

function generateString(config: FuzzConfig): string {
  let length = config.length ?? 0
  if (length <= 0) {
    const minLen = config.minLength ?? 8
    const maxLen = config.maxLength ?? minLen + 10
    length = randomInt(minLen, Math.max(minLen, maxLen))
  }

  let charset = ALPHANUM
  if (config.includeSpaces) charset += " "
  if (config.includeSpecialChars) charset += SPECIAL

  let result = ""
  for (let i = 0; i < length; i++) {
    result += charset[randomInt(0, charset.length - 1)]
  }

  return (config.prefix ?? "") + result + (config.suffix ?? "")
}

function generateInt(config: FuzzConfig): number {
  let min = config.min ?? 0
  let max = config.max ?? 0
  if (max <= min) { min = 0; max = 100 }
  return randomInt(min, max)
}

function generateFloat(config: FuzzConfig): number {
  let min = config.min ?? 0
  let max = config.max ?? 0
  if (max <= min) { min = 0; max = 100 }
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
  if (config.format) {
    // Simple format support for YYYY-MM-DD
    return formatDate(date, config.format)
  }
  return date.toISOString().slice(0, 10)
}

function generateTimestamp(config: FuzzConfig): string {
  const date = randomTimeInRange(config.minDate, config.maxDate, false)
  if (config.format) return formatDate(date, config.format)
  return date.toISOString()
}

function formatDate(d: Date, fmt: string): string {
  // Support Go-style reference date format: 2006-01-02T15:04:05Z07:00
  return fmt
    .replace("2006", String(d.getFullYear()))
    .replace("01", String(d.getMonth() + 1).padStart(2, "0"))
    .replace("02", String(d.getDate()).padStart(2, "0"))
    .replace("15", String(d.getHours()).padStart(2, "0"))
    .replace("04", String(d.getMinutes()).padStart(2, "0"))
    .replace("05", String(d.getSeconds()).padStart(2, "0"))
}

function generateWords(config: FuzzConfig): string {
  let count = config.wordCount ?? 0
  if (count <= 0) {
    const minCount = config.minWordCount ?? 2
    const maxCount = config.maxWordCount ?? minCount + 3
    count = randomInt(minCount, Math.max(minCount, maxCount))
  }
  const result: string[] = []
  for (let i = 0; i < count; i++) {
    result.push(randomChoice(WORDS))
  }
  return result.join(" ")
}

function generateList(config: FuzzConfig): string {
  let count = config.count ?? 0
  if (count <= 0) {
    const minCount = config.minCount ?? 2
    const maxCount = config.maxCount ?? minCount + 3
    count = randomInt(minCount, Math.max(minCount, maxCount))
  }
  const items: string[] = []
  const itemConfig: FuzzConfig = {
    type: "string",
    minLength: config.minLength ?? 5,
    maxLength: config.maxLength ?? 12,
  }
  for (let i = 0; i < count; i++) {
    items.push(generateString(itemConfig))
  }
  return JSON.stringify(items)
}

function generateMap(config: FuzzConfig): unknown {
  let count = config.count ?? 0
  if (count <= 0) {
    const minCount = config.minCount ?? 2
    const maxCount = config.maxCount ?? minCount + 2
    count = randomInt(minCount, Math.max(minCount, maxCount))
  }

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
  const valueConfig: FuzzConfig = {
    type: "string",
    minLength: config.minLength ?? 5,
    maxLength: config.maxLength ?? 12,
  }
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
