import { describe, it, expect } from 'vitest'
import {
  extractTemplateDependenciesFromString,
  splitDependencies,
} from './extractTemplateDependencies'

describe('extractTemplateDependenciesFromString', () => {
  it('should return empty array for empty or null-ish content', () => {
    expect(extractTemplateDependenciesFromString('')).toEqual([])
    expect(extractTemplateDependenciesFromString(null as unknown as string)).toEqual([])
    expect(extractTemplateDependenciesFromString(undefined as unknown as string)).toEqual([])
  })

  it('should return empty array for content without template expressions', () => {
    expect(extractTemplateDependenciesFromString('plain text')).toEqual([])
    expect(extractTemplateDependenciesFromString('no templates here')).toEqual([])
  })

  it('should extract input dependencies', () => {
    const deps = extractTemplateDependenciesFromString('{{ .inputs.region }}')
    expect(deps).toEqual([
      { type: 'input', name: 'region' },
    ])
  })

  it('should extract multiple input dependencies', () => {
    const deps = extractTemplateDependenciesFromString(
      'deploy --region {{ .inputs.region }} --env {{ .inputs.environment }}'
    )
    expect(deps).toEqual([
      { type: 'input', name: 'region' },
      { type: 'input', name: 'environment' },
    ])
  })

  it('should extract output dependencies', () => {
    const deps = extractTemplateDependenciesFromString(
      '{{ .outputs.create_account.account_id }}'
    )
    expect(deps).toEqual([
      { type: 'output', blockId: 'create_account', outputName: 'account_id', fullPath: 'outputs.create_account.account_id' },
    ])
  })

  it('should extract mixed input and output dependencies', () => {
    const deps = extractTemplateDependenciesFromString(
      'deploy --region {{ .inputs.region }} --account {{ .outputs.create_account.account_id }}'
    )
    expect(deps).toEqual([
      { type: 'input', name: 'region' },
      { type: 'output', blockId: 'create_account', outputName: 'account_id', fullPath: 'outputs.create_account.account_id' },
    ])
  })

  it('should handle whitespace trimming markers', () => {
    const deps = extractTemplateDependenciesFromString('{{- .inputs.region -}}')
    expect(deps).toEqual([
      { type: 'input', name: 'region' },
    ])
  })

  it('should handle pipe functions', () => {
    const deps = extractTemplateDependenciesFromString(
      '{{ .inputs.name | upper }} {{ .outputs.block.key | lower }}'
    )
    expect(deps).toEqual([
      { type: 'input', name: 'name' },
      { type: 'output', blockId: 'block', outputName: 'key', fullPath: 'outputs.block.key' },
    ])
  })

  it('should handle expressions inside function calls', () => {
    const deps = extractTemplateDependenciesFromString(
      '{{- range (fromJson .outputs.create_account.json_data) -}}'
    )
    expect(deps).toEqual([
      { type: 'output', blockId: 'create_account', outputName: 'json_data', fullPath: 'outputs.create_account.json_data' },
    ])
  })

  it('should deduplicate identical dependencies', () => {
    const deps = extractTemplateDependenciesFromString(
      '{{ .inputs.region }} {{ .inputs.region }}'
    )
    expect(deps).toEqual([
      { type: 'input', name: 'region' },
    ])
  })

  it('should normalize block IDs with hyphens for deduplication', () => {
    const deps = extractTemplateDependenciesFromString(
      '{{ .outputs.create-account.account_id }}'
    )
    expect(deps).toHaveLength(1)
    expect(deps[0]).toEqual({
      type: 'output',
      blockId: 'create-account',
      outputName: 'account_id',
      fullPath: 'outputs.create_account.account_id',
    })
  })

  it('should deduplicate hyphenated and underscored block IDs', () => {
    const deps = extractTemplateDependenciesFromString(
      '{{ .outputs.create-account.account_id }} {{ .outputs.create_account.account_id }}'
    )
    // Both resolve to the same normalized path, so only one dep
    expect(deps).toHaveLength(1)
  })

  it('should ignore references outside template delimiters', () => {
    const deps = extractTemplateDependenciesFromString(
      '// .inputs.region is just a comment\n{{ .inputs.actual }}'
    )
    expect(deps).toEqual([
      { type: 'input', name: 'actual' },
    ])
  })

  it('should handle multiline template content', () => {
    const deps = extractTemplateDependenciesFromString(
      `line1 {{ .inputs.region }}
line2 {{ .outputs.deploy.result }}
line3 {{ .inputs.env }}`
    )
    expect(deps).toHaveLength(3)
    expect(deps[0]).toEqual({ type: 'input', name: 'region' })
    expect(deps[1]).toEqual({ type: 'output', blockId: 'deploy', outputName: 'result', fullPath: 'outputs.deploy.result' })
    expect(deps[2]).toEqual({ type: 'input', name: 'env' })
  })

  it('should not match old-style bare variable syntax', () => {
    const deps = extractTemplateDependenciesFromString('{{ .region }}')
    expect(deps).toEqual([])
  })

  it('should not match old-style _blocks syntax', () => {
    const deps = extractTemplateDependenciesFromString(
      '{{ ._blocks.create_account.outputs.account_id }}'
    )
    expect(deps).toEqual([])
  })

  it('should ignore output references without an output name', () => {
    const deps = extractTemplateDependenciesFromString('{{ .outputs.block_only }}')
    expect(deps).toEqual([])
  })
})

describe('splitDependencies', () => {
  it('should split empty array', () => {
    const result = splitDependencies([])
    expect(result).toEqual({ inputs: [], outputs: [] })
  })

  it('should split mixed dependencies', () => {
    const deps = extractTemplateDependenciesFromString(
      '{{ .inputs.region }} {{ .outputs.block.key }}'
    )
    const { inputs, outputs } = splitDependencies(deps)
    expect(inputs).toEqual(['region'])
    expect(outputs).toEqual([
      { blockId: 'block', outputName: 'key', fullPath: 'outputs.block.key' },
    ])
  })

  it('should deduplicate within groups', () => {
    const deps = [
      ...extractTemplateDependenciesFromString('{{ .inputs.region }}'),
      ...extractTemplateDependenciesFromString('{{ .inputs.region }}'),
    ]
    const { inputs } = splitDependencies(deps)
    expect(inputs).toEqual(['region'])
  })
})
