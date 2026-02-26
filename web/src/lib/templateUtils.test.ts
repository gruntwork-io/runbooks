import { describe, it, expect } from 'vitest'
import {
  flattenBlockOutputs,
  computeUnmetInputDependencies,
  resolveTemplateReferences,
} from './templateUtils'
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

  it('should return empty string for missing input values', () => {
    expect(resolveTemplateReferences('{{ .inputs.nonexistent }}', ctx)).toBe('')
  })

  it('should return empty string for missing output values', () => {
    expect(resolveTemplateReferences('{{ .outputs.missing_block.key }}', ctx)).toBe('')
  })

  it('should return empty string for missing output key on existing block', () => {
    expect(resolveTemplateReferences('{{ .outputs.create_account.missing }}', ctx)).toBe('')
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
})
