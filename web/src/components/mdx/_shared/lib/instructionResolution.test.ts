import { describe, it, expect } from 'vitest'
import {
  detectManualFields,
  buildManualOutputs,
  buildInputPlaceholders,
  buildMergedContext,
  resolveCommandClientSide,
  normalizeCommandList,
} from './instructionResolution'
import type { TemplateContext } from '@/lib/templateUtils'

describe('detectManualFields', () => {
  it('returns no fields for a command without output references', () => {
    expect(detectManualFields('aws s3 ls {{ .inputs.bucket }}')).toEqual([])
  })

  it('synthesizes one field per distinct output reference', () => {
    const fields = detectManualFields(
      'echo {{ .outputs.create_account.account_id }} {{ .outputs.create_account.arn }}',
    )
    expect(fields).toHaveLength(2)
    expect(fields.map((f) => f.outputName).sort()).toEqual(['account_id', 'arn'])
  })

  it('dedupes repeated references', () => {
    const fields = detectManualFields([
      'a {{ .outputs.step.x }}',
      'b {{ .outputs.step.x }}',
    ])
    expect(fields).toHaveLength(1)
  })

  it('labels a field with the default "<key> — output of step <id>" form', () => {
    const [field] = detectManualFields('{{ .outputs.create-account.account_id }}')
    expect(field.label).toBe('account_id — output of step create-account')
  })
})

describe('buildManualOutputs', () => {
  it('uses a <key> placeholder when a field is empty', () => {
    const fields = detectManualFields('{{ .outputs.step.arn }}')
    const outputs = buildManualOutputs(fields, {})
    expect(outputs.step.arn).toBe('<arn>')
  })

  it('uses the entered value when present', () => {
    const fields = detectManualFields('{{ .outputs.step.arn }}')
    const outputs = buildManualOutputs(fields, { 'outputs.step.arn': 'arn:aws:x' })
    expect(outputs.step.arn).toBe('arn:aws:x')
  })

  it('stores under both normalized and original block ids', () => {
    const fields = detectManualFields('{{ .outputs.create-account.id }}')
    const outputs = buildManualOutputs(fields, {
      'outputs.create_account.id': '123',
    })
    expect(outputs['create_account'].id).toBe('123')
    expect(outputs['create-account'].id).toBe('123')
  })
})

describe('buildInputPlaceholders', () => {
  it('fills a <name> placeholder for an input no form has set', () => {
    const inputs = buildInputPlaceholders(
      ['aws s3 cp {{ .inputs.src }} s3://{{ .inputs.bucket }}'],
      { src: './dist' },
    )
    expect(inputs).toEqual({ src: './dist', bucket: '<bucket>' })
  })

  it('treats undefined, null, and empty values as unset', () => {
    const inputs = buildInputPlaceholders(
      ['{{ .inputs.a }} {{ .inputs.b }} {{ .inputs.c }} {{ .inputs.d }}'],
      { a: undefined, b: null, c: '', d: false },
    )
    expect(inputs).toEqual({ a: '<a>', b: '<b>', c: '<c>', d: false })
  })

  it('fills references inside template logic too', () => {
    const inputs = buildInputPlaceholders(['{{ if .inputs.verbose }}-v{{ end }}'], {})
    expect(inputs).toEqual({ verbose: '<verbose>' })
  })

  it('nests the placeholder for a dotted reference without mutating the input', () => {
    const base = { tags: { team: 'infra' } }
    const inputs = buildInputPlaceholders(
      ['{{ .inputs.tags.env }} {{ .inputs._module.source }}'],
      base,
    )
    expect(inputs).toEqual({
      tags: { team: 'infra', env: '<env>' },
      _module: { source: '<source>' },
    })
    expect(base).toEqual({ tags: { team: 'infra' } })
  })

  it('leaves a set nested value alone', () => {
    const base = { _module: { source: 'git::x' } }
    expect(buildInputPlaceholders(['{{ .inputs._module.source }}'], base)).toBe(base)
  })

  it('does not replace a scalar that a dotted reference treats as an object', () => {
    const inputs = buildInputPlaceholders(['{{ .inputs.tags.env }}'], { tags: 'infra' })
    expect(inputs).toEqual({ tags: 'infra' })
  })
})

describe('resolveCommandClientSide + buildMergedContext', () => {
  const base: TemplateContext = {
    inputs: { bucket: 'my-bucket' },
    outputs: {},
  }

  it('resolves input references from the form context', () => {
    const resolved = resolveCommandClientSide(
      'aws s3 ls s3://{{ .inputs.bucket }}',
      base,
    )
    expect(resolved).toBe('aws s3 ls s3://my-bucket')
  })

  it('resolves output references from merged manual values', () => {
    const fields = detectManualFields('echo {{ .outputs.step.arn }}')
    const merged = buildMergedContext(base, fields, {
      'outputs.step.arn': 'arn:aws:s3',
    }, ['echo {{ .outputs.step.arn }}'])
    const resolved = resolveCommandClientSide('echo {{ .outputs.step.arn }}', merged)
    expect(resolved).toBe('echo arn:aws:s3')
    expect(resolved).not.toContain('{{')
  })

  it('never leaves a raw {{ }} when an output value is still empty', () => {
    const fields = detectManualFields('echo {{ .outputs.step.arn }}')
    const merged = buildMergedContext(base, fields, {}, ['echo {{ .outputs.step.arn }}'])
    const resolved = resolveCommandClientSide('echo {{ .outputs.step.arn }}', merged)
    expect(resolved).not.toContain('{{')
    expect(resolved).toBe('echo <arn>')
  })

  it('never leaves a raw {{ }} for an input no form has set', () => {
    const command = 'aws s3 ls s3://{{ .inputs.bucket }}/{{ .inputs.prefix }}'
    const merged = buildMergedContext({ inputs: { prefix: 'logs' }, outputs: {} }, [], {}, [command])
    expect(resolveCommandClientSide(command, merged)).toBe('aws s3 ls s3://<bucket>/logs')
  })

  it('resolves a nested input reference', () => {
    const ctx: TemplateContext = { inputs: { _module: { source: 'git::x' } }, outputs: {} }
    expect(resolveCommandClientSide('echo {{ .inputs._module.source }}', ctx)).toBe('echo git::x')
  })

  it('preserves a block\'s other output keys when layering a manual value', () => {
    // `step` already published `path` in context; only `step.arn` needs a prompt
    // (as fieldsNeedingPrompt would filter). Merging it must not drop `step.path`.
    const ctx: TemplateContext = {
      inputs: {},
      outputs: { step: { path: '/tmp/work' } },
    }
    const fields = detectManualFields('echo {{ .outputs.step.arn }}')
    const merged = buildMergedContext(ctx, fields, { 'outputs.step.arn': 'arn:aws:s3' }, [
      'echo {{ .outputs.step.arn }}',
    ])
    expect(merged.outputs.step).toEqual({ path: '/tmp/work', arn: 'arn:aws:s3' })
  })
})

describe('normalizeCommandList', () => {
  it('handles undefined, string, and array', () => {
    expect(normalizeCommandList(undefined)).toEqual([])
    expect(normalizeCommandList('a')).toEqual(['a'])
    expect(normalizeCommandList(['a', 'b'])).toEqual(['a', 'b'])
  })
})
