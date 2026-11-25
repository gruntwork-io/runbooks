#!/usr/bin/env bun
/**
 * Writes the JSON Schema an editor checks `runbook_test.yml` against, from
 * the schema `runbooks test` decodes with, so the two cannot drift:
 *
 *   bun packages/cli/src/writeTestFileSchema.ts [file]
 *
 * With no file, it goes to stdout.
 */
import { writeFileSync } from "node:fs"
import { testFileJsonSchema } from "./testFile.ts"

const [out] = process.argv.slice(2)
if (out === undefined) process.stdout.write(testFileJsonSchema())
else writeFileSync(out, testFileJsonSchema())
