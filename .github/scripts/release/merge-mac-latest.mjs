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
// Usage: merge-mac-latest.mjs <output.yml> <input1.yml> [input2.yml ...]
//
// Top-level metadata (version, releaseDate, and the legacy path/sha512 fields)
// is taken from the first input; only `files` is unioned (deduped by url). Pass
// the arm64 manifest first so the legacy top-level path matches what a single
// both-arch `electron-builder --mac` run would emit. The output path may be the
// same as one of the inputs -- all inputs are read before anything is written.

import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify, Scalar } from "yaml";

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) {
  console.error(
    "Usage: merge-mac-latest.mjs <output.yml> <input1.yml> [input2.yml ...]",
  );
  process.exit(1);
}

const docs = inputs.map((path) => ({ path, doc: parse(readFileSync(path, "utf8")) }));

const base = docs[0].doc;
const merged = { ...base, files: [] };
const seen = new Set();

for (const { path, doc } of docs) {
  if (doc.version !== base.version) {
    console.error(
      `Version mismatch: ${path} is ${doc.version}, expected ${base.version} (from ${docs[0].path})`,
    );
    process.exit(1);
  }
  for (const file of doc.files ?? []) {
    if (seen.has(file.url)) continue;
    seen.add(file.url);
    merged.files.push(file);
  }
}

// electron-builder emits `releaseDate` as a quoted string. Preserve the quotes:
// js-yaml (which electron-updater uses to parse the manifest) decodes an
// *unquoted* ISO timestamp as a Date rather than the string the type expects.
if (typeof merged.releaseDate === "string") {
  merged.releaseDate = Object.assign(new Scalar(merged.releaseDate), {
    type: Scalar.QUOTE_SINGLE,
  });
}

writeFileSync(output, stringify(merged));
console.log(`Merged ${inputs.length} manifest(s) into ${output}:`);
for (const f of merged.files) console.log(`  - ${f.url}`);
