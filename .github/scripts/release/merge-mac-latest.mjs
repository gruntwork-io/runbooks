#!/usr/bin/env node
// Merge multiple electron-builder `latest-mac.yml` auto-update manifests into one.

import { readFileSync, writeFileSync } from "node:fs"
import { parse, stringify, Scalar } from "yaml"

const MINIMUM_DARWIN_VERSION = "22.0.0"

// A single-quoted YAML string, so js-yaml (which electron-updater uses to parse
// the manifest) reads it back as a string.
const quoted = (value) => Object.assign(new Scalar(value), { type: Scalar.QUOTE_SINGLE })

const [output, ...inputs] = process.argv.slice(2)
if (!output || inputs.length === 0) {
  console.error("Usage: merge-mac-latest.mjs <output.yml> <input1.yml> [input2.yml ...]")
  process.exit(1)
}

const docs = inputs.map((path) => ({ path, doc: parse(readFileSync(path, "utf8")) }))

const base = docs[0].doc
const merged = { ...base, files: [] }
const seen = new Set()

for (const { path, doc } of docs) {
  if (doc.version !== base.version) {
    console.error(
      `Version mismatch: ${path} is ${doc.version}, expected ${base.version} (from ${docs[0].path})`,
    )
    process.exit(1)
  }
  for (const file of doc.files ?? []) {
    if (seen.has(file.url)) continue
    seen.add(file.url)
    merged.files.push(file)
  }
}

// electron-builder emits `releaseDate` as a quoted string. Preserve the quotes:
// js-yaml decodes an *unquoted* ISO timestamp as a Date rather than the string
// the type expects.
if (typeof merged.releaseDate === "string") {
  merged.releaseDate = quoted(merged.releaseDate)
}

merged.minimumSystemVersion = quoted(MINIMUM_DARWIN_VERSION)

writeFileSync(output, stringify(merged))
console.log(`Merged ${inputs.length} manifest(s) into ${output}:`)
for (const f of merged.files) console.log(`  - ${f.url}`)
console.log(`minimumSystemVersion: ${MINIMUM_DARWIN_VERSION}`)
