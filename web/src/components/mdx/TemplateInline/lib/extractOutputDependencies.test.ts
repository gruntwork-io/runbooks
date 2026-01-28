import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { extractOutputDependenciesFromString } from './extractOutputDependencies'
import { normalizeBlockId } from '@/lib/utils'

/**
 * These tests validate the TypeScript output dependency regex implementation
 * against shared test fixtures that are also used by the Go implementation.
 * This ensures both implementations stay in sync.
 *
 * Shared fixtures: testdata/test-fixtures/output-dependencies/patterns.json
 * Go implementation: api/boilerplate_config.go (OutputDependencyRegex)
 */

interface ExpectedDependency {
  blockId: string
  outputName: string
}

interface TestCase {
  name: string
  input: string
  expected: ExpectedDependency[]
}

interface TestFixtures {
  description: string
  pattern_description: string
  cases: TestCase[]
}

describe('extractOutputDependenciesFromString - shared fixtures', () => {
  // Load the shared test fixtures
  const fixturesPath = join(__dirname, '../../../../../../testdata/test-fixtures/output-dependencies/patterns.json')
  const fixturesData = readFileSync(fixturesPath, 'utf-8')
  const fixtures: TestFixtures = JSON.parse(fixturesData)

  // Generate a test for each fixture case
  fixtures.cases.forEach((testCase) => {
    it(testCase.name, () => {
      const result = extractOutputDependenciesFromString(testCase.input)

      // Verify the count matches
      expect(result.length).toBe(testCase.expected.length)

      // Verify each expected dependency is found
      testCase.expected.forEach((expected, i) => {
        expect(result[i].blockId).toBe(expected.blockId)
        expect(result[i].outputName).toBe(expected.outputName)

        // Also verify the fullPath is constructed correctly
        // Note: fullPath uses normalized block ID (hyphens → underscores) for Go template compatibility
        const normalizedBlockId = normalizeBlockId(expected.blockId)
        const expectedFullPath = `_blocks.${normalizedBlockId}.outputs.${expected.outputName}`
        expect(result[i].fullPath).toBe(expectedFullPath)
      })
    })
  })
})
