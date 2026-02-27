import { describe, it, expect } from 'vitest'
import {
  flattenBlockOutputs,
  computeUnmetInputDependencies,
  resolveTemplateReferences,
} from './templateUtils'
import type { TemplateContext } from './templateUtils'
import { extractTemplateDependenciesFromString } from './extractTemplateDependencies'
import type { BlockOutputs } from '@/contexts/RunbookContext'

describe('flattenBlockOutputs', () => {
  it('should return empty object for empty input', () => {
    expect(flattenBlockOutputs({})).toEqual({})
  })

  it('should strip the .values wrapper from block outputs', () => {
    const allOutputs: Record<string, BlockOutputs> = {
      create_account: {
        values: { account_id: '123', role_arn: 'arn:aws:iam::123:role/Admin' },
        timestamp: '2024-01-01T00:00:00Z',
      },
      deploy: {
        values: { status: 'success' },
        timestamp: '2024-01-01T00:01:00Z',
      },
    }

    expect(flattenBlockOutputs(allOutputs)).toEqual({
      create_account: { account_id: '123', role_arn: 'arn:aws:iam::123:role/Admin' },
      deploy: { status: 'success' },
    })
  })
})

describe('computeUnmetInputDependencies', () => {
  it('should return empty array when no deps', () => {
    expect(computeUnmetInputDependencies([], {})).toEqual([])
  })

  it('should return all deps when inputs are empty', () => {
    expect(computeUnmetInputDependencies(['region', 'env'], {})).toEqual(['region', 'env'])
  })

  it('should return only missing deps', () => {
    expect(
      computeUnmetInputDependencies(['region', 'env'], { region: 'us-west-2' })
    ).toEqual(['env'])
  })

  it('should return empty array when all deps satisfied', () => {
    expect(
      computeUnmetInputDependencies(['region'], { region: 'us-west-2' })
    ).toEqual([])
  })

  it('should treat null, undefined, and empty string as unmet', () => {
    expect(
      computeUnmetInputDependencies(
        ['a', 'b', 'c'],
        { a: null, b: undefined, c: '' }
      )
    ).toEqual(['a', 'b', 'c'])
  })

  it('should treat 0 and false as valid values', () => {
    expect(
      computeUnmetInputDependencies(['count', 'enabled'], { count: 0, enabled: false })
    ).toEqual([])
  })
})

describe('resolveTemplateReferences', () => {
  const ctx = {
    inputs: { region: 'us-west-2', env: 'prod', name: 'my-app' },
    outputs: {
      create_account: { account_id: '123456789012', role_arn: 'arn:aws:iam::123:role/Admin' },
      deploy: { status: 'success' },
    },
  }

  it('should return empty/null-ish text unchanged', () => {
    expect(resolveTemplateReferences('', ctx)).toBe('')
    expect(resolveTemplateReferences(null as unknown as string, ctx)).toBe(null)
    expect(resolveTemplateReferences(undefined as unknown as string, ctx)).toBe(undefined)
  })

  it('should return text without templates unchanged', () => {
    expect(resolveTemplateReferences('plain text', ctx)).toBe('plain text')
  })

  it('should resolve input references', () => {
    expect(resolveTemplateReferences('{{ .inputs.region }}', ctx)).toBe('us-west-2')
  })

  it('should resolve output references', () => {
    expect(
      resolveTemplateReferences('{{ .outputs.create_account.account_id }}', ctx)
    ).toBe('123456789012')
  })

  it('should resolve output references with hyphenated block IDs', () => {
    expect(
      resolveTemplateReferences('{{ .outputs.create-account.account_id }}', ctx)
    ).toBe('123456789012')
  })

  it('should resolve mixed references in a string', () => {
    expect(
      resolveTemplateReferences(
        'deploy --region {{ .inputs.region }} --account {{ .outputs.create_account.account_id }}',
        ctx
      )
    ).toBe('deploy --region us-west-2 --account 123456789012')
  })

  it('should handle whitespace trimming markers', () => {
    expect(resolveTemplateReferences('{{- .inputs.region -}}', ctx)).toBe('us-west-2')
  })

  it('should handle pipe functions (strips them, resolves base value)', () => {
    expect(resolveTemplateReferences('{{ .inputs.region | upper }}', ctx)).toBe('us-west-2')
  })

  it('should wrap missing input values in backticks for inline-code rendering', () => {
    expect(resolveTemplateReferences('{{ .inputs.nonexistent }}', ctx)).toBe('`{{ .inputs.nonexistent }}`')
  })

  it('should wrap missing output values in backticks for inline-code rendering', () => {
    expect(resolveTemplateReferences('{{ .outputs.missing_block.key }}', ctx)).toBe('`{{ .outputs.missing_block.key }}`')
  })

  it('should wrap missing output key on existing block in backticks', () => {
    expect(resolveTemplateReferences('{{ .outputs.create_account.missing }}', ctx)).toBe('`{{ .outputs.create_account.missing }}`')
  })

  it('should handle multiple occurrences', () => {
    expect(
      resolveTemplateReferences('{{ .inputs.region }}-{{ .inputs.env }}', ctx)
    ).toBe('us-west-2-prod')
  })

  it('should not resolve old-style bare variables', () => {
    expect(resolveTemplateReferences('{{ .region }}', ctx)).toBe('{{ .region }}')
  })

  it('should not resolve old-style _blocks references', () => {
    expect(
      resolveTemplateReferences('{{ ._blocks.create_account.outputs.account_id }}', ctx)
    ).toBe('{{ ._blocks.create_account.outputs.account_id }}')
  })

  it('should coerce non-string input values via String()', () => {
    const numCtx: TemplateContext = {
      inputs: { count: 0, enabled: false, pi: 3.14 },
      outputs: {},
    }
    expect(resolveTemplateReferences('{{ .inputs.count }}', numCtx)).toBe('0')
    expect(resolveTemplateReferences('{{ .inputs.enabled }}', numCtx)).toBe('false')
    expect(resolveTemplateReferences('{{ .inputs.pi }}', numCtx)).toBe('3.14')
  })

  it('should wrap output reference without output name in backticks', () => {
    const outCtx: TemplateContext = {
      inputs: {},
      outputs: { block_only: { key: 'val' } },
    }
    expect(resolveTemplateReferences('{{ .outputs.block_only }}', outCtx)).toBe('`{{ .outputs.block_only }}`')
  })
})

describe('extract → resolve contract', () => {
  it('should resolve all simple expressions that the extractor finds', () => {
    const template = 'url: {{ .inputs.region }}, acct: {{ .outputs.create_account.account_id }}'
    const deps = extractTemplateDependenciesFromString(template)

    expect(deps).toHaveLength(2)

    const ctx: TemplateContext = {
      inputs: { region: 'us-east-1' },
      outputs: { create_account: { account_id: '999' } },
    }

    const resolved = resolveTemplateReferences(template, ctx)
    expect(resolved).toBe('url: us-east-1, acct: 999')
    expect(resolved).not.toMatch(/\{\{/)
  })

  it('should leave complex expressions (function calls) unresolved', () => {
    const template = '{{- range (fromJson .outputs.block.data) -}}item{{ end }}'
    const deps = extractTemplateDependenciesFromString(template)

    expect(deps).toHaveLength(1)
    expect(deps[0]).toMatchObject({ type: 'output', blockId: 'block', outputName: 'data' })

    const ctx: TemplateContext = {
      inputs: {},
      outputs: { block: { data: '["a","b"]' } },
    }
    const resolved = resolveTemplateReferences(template, ctx)
    expect(resolved).toContain('fromJson')
  })
})
