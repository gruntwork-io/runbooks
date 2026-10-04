#!/usr/bin/env node
// Merge multiple electron-builder `latest-mac.yml` auto-update manifests into one.
//
// The macOS release packages arm64 and x64 in two separate `electron-builder`
// passes (see release.yml for why one-arch-at-a-time is required). Each pass
// rewrites `latest-mac.yml` from scratch listing only the artifacts it just
// produced -- electron-builder only merges against a *remote* manifest when
// publishing, and our passes use `--publish never`. So the second (x64) pass
// clobbers the first (arm64) pass's metadata, and the published manifest ends
// up arch-incomplete.
//
// This matters because electron-updater's MacUpdater picks the arch by scanning
// the `files` array for an "arm64" url (MacUpdater.js: `isArm64`). When no entry
// matches, an arm64 Mac silently falls through to the x64 zip -- i.e. arm64
// users auto-update to an x64 build that then runs under Rosetta. Merging the
// per-pass `files` arrays back together restores correct per-arch updates.
//
// The merged manifest also gets `minimumSystemVersion`, which electron-builder
// never writes, so Macs too old for a release don't auto-update into an app
// that won't launch (see MINIMUM_DARWIN_VERSION below).
//
// Usage: merge-mac-latest.mjs <output.yml> <input1.yml> [input2.yml ...]
//
// Top-level metadata (version, releaseDate, and the legacy path/sha512 fields)
// is taken from the first input, `files` is unioned (deduped by url), and
// `minimumSystemVersion` is set to MINIMUM_DARWIN_VERSION. Pass the arm64
// manifest first so the legacy top-level path matches what a single both-arch
// `electron-builder --mac` run would emit. The output path may be the same as
// one of the inputs -- all inputs are read before anything is written.

import { readFileSync, writeFileSync } from "node:fs"
import { parse, stringify, Scalar } from "yaml"

// The oldest macOS Runbooks supports, as the Darwin kernel version that
// os.release() reports, not the macOS version: macOS 13 Ventura is Darwin 22,
// but macOS 26 is Darwin 25, so look the number up. Releases still ship
// Electron 41, which runs on macOS 12, but Runbooks requires macOS 13
// (Darwin 22) or later from here on because the Electron 44 upgrade needs
// it. The installed app's electron-updater (6.8.3 in every release since
// v0.11.0) skips an update in AppUpdater.isUpdateAvailable when os.release()
// is semver-below this, so a macOS 12 install isn't offered the update and
// keeps the version it has.
//
// app-builder-lib 26 puts mac.minimumSystemVersion only in the app's
// LSMinimumSystemVersion, and its releaseInfo option rejects extra keys, so the
// manifest gets the value here. Keep it a full x.y.z version: electron-updater
// offers the update anyway when semver can't parse it. Raise it when an
// Electron upgrade raises the macOS floor past it. That floor is the
// LSMinimumSystemVersion in Electron.app/Contents/Info.plist under
// node_modules/electron/dist; since Electron 42, bun install no longer
// downloads that binary, so run `node node_modules/electron/install.js` first.
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
