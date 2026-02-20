import { describe, it, expect } from 'vitest'
import { formatHclValue, buildHclInputsMap } from './formatHclValue'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

describe('formatHclValue', () => {
  describe('Bool type', () => {
    it('formats boolean true', () => {
      expect(formatHclValue(true, BoilerplateVariableType.Bool)).toBe('true')
    })

    it('formats boolean false', () => {
      expect(formatHclValue(false, BoilerplateVariableType.Bool)).toBe('false')
    })

    it('formats string "true" as boolean true', () => {
      expect(formatHclValue('true', BoilerplateVariableType.Bool)).toBe('true')
    })

    it('formats string "false" as boolean false', () => {
      expect(formatHclValue('false', BoilerplateVariableType.Bool)).toBe('false')
    })

    it('formats empty string as false', () => {
      expect(formatHclValue('', BoilerplateVariableType.Bool)).toBe('false')
    })

    it('formats null as false', () => {
      expect(formatHclValue(null, BoilerplateVariableType.Bool)).toBe('false')
    })

    it('formats undefined as false', () => {
      expect(formatHclValue(undefined, BoilerplateVariableType.Bool)).toBe('false')
    })

    it('formats non-boolean truthy values as false', () => {
      // Only true and "true" produce "true"
      expect(formatHclValue(1, BoilerplateVariableType.Bool)).toBe('false')
      expect(formatHclValue('yes', BoilerplateVariableType.Bool)).toBe('false')
    })
  })

  describe('Int type', () => {
    it('formats number', () => {
      expect(formatHclValue(42, BoilerplateVariableType.Int)).toBe('42')
    })

    it('formats zero', () => {
      expect(formatHclValue(0, BoilerplateVariableType.Int)).toBe('0')
    })

    it('formats negative number', () => {
      expect(formatHclValue(-5, BoilerplateVariableType.Int)).toBe('-5')
    })

    it('formats string number', () => {
      expect(formatHclValue('42', BoilerplateVariableType.Int)).toBe('42')
    })

    it('defaults invalid string to 0', () => {
      expect(formatHclValue('abc', BoilerplateVariableType.Int)).toBe('0')
    })

    it('defaults empty string to 0', () => {
      expect(formatHclValue('', BoilerplateVariableType.Int)).toBe('0')
    })

    it('defaults null to 0', () => {
      expect(formatHclValue(null, BoilerplateVariableType.Int)).toBe('0')
    })

    it('defaults undefined to 0', () => {
      expect(formatHclValue(undefined, BoilerplateVariableType.Int)).toBe('0')
    })
  })

  describe('Float type', () => {
    it('formats float number', () => {
      expect(formatHclValue(3.14, BoilerplateVariableType.Float)).toBe('3.14')
    })

    it('formats string float', () => {
      expect(formatHclValue('3.14', BoilerplateVariableType.Float)).toBe('3.14')
    })

    it('defaults invalid string to 0', () => {
      expect(formatHclValue('not-a-number', BoilerplateVariableType.Float)).toBe('0')
    })
  })

  describe('String type', () => {
    it('quotes string values', () => {
      expect(formatHclValue('hello', BoilerplateVariableType.String)).toBe('"hello"')
    })

    it('quotes empty string', () => {
      expect(formatHclValue('', BoilerplateVariableType.String)).toBe('""')
    })

    it('handles null as empty string', () => {
      expect(formatHclValue(null, BoilerplateVariableType.String)).toBe('""')
    })

    it('handles undefined as empty string', () => {
      expect(formatHclValue(undefined, BoilerplateVariableType.String)).toBe('""')
    })

    it('escapes special characters in strings', () => {
      expect(formatHclValue('say "hi"', BoilerplateVariableType.String)).toBe('"say \\"hi\\""')
    })

    it('converts number to quoted string', () => {
      expect(formatHclValue(42, BoilerplateVariableType.String)).toBe('"42"')
    })
  })

  describe('Enum type', () => {
    it('quotes enum values', () => {
      expect(formatHclValue('us-east-1', BoilerplateVariableType.Enum)).toBe('"us-east-1"')
    })

    it('quotes empty enum', () => {
      expect(formatHclValue('', BoilerplateVariableType.Enum)).toBe('""')
    })
  })

  describe('List type', () => {
    it('JSON-encodes array values', () => {
      expect(formatHclValue(['a', 'b'], BoilerplateVariableType.List)).toBe('["a","b"]')
    })

    it('passes through valid JSON string', () => {
      expect(formatHclValue('["a","b"]', BoilerplateVariableType.List)).toBe('["a","b"]')
    })

    it('JSON-encodes non-JSON string', () => {
      expect(formatHclValue('not-json', BoilerplateVariableType.List)).toBe('"not-json"')
    })

    it('handles empty array', () => {
      expect(formatHclValue([], BoilerplateVariableType.List)).toBe('[]')
    })

    it('handles null', () => {
      expect(formatHclValue(null, BoilerplateVariableType.List)).toBe('null')
    })
  })

  describe('Map type', () => {
    it('JSON-encodes object values', () => {
      expect(formatHclValue({ key: 'val' }, BoilerplateVariableType.Map)).toBe('{"key":"val"}')
    })

    it('passes through valid JSON object string', () => {
      expect(formatHclValue('{"key":"val"}', BoilerplateVariableType.Map)).toBe('{"key":"val"}')
    })

    it('handles empty object', () => {
      expect(formatHclValue({}, BoilerplateVariableType.Map)).toBe('{}')
    })

    it('handles nested objects', () => {
      const nested = { a: { b: 'c' } }
      expect(formatHclValue(nested, BoilerplateVariableType.Map)).toBe('{"a":{"b":"c"}}')
    })
  })

  describe('default case', () => {
    it('treats unknown types as string', () => {
      // Force an unknown type to test the default branch
      expect(formatHclValue('test', 'unknown' as BoilerplateVariableType)).toBe('"test"')
    })
  })
})

describe('buildHclInputsMap', () => {
  const makeConfig = (vars: Array<{ name: string; type: BoilerplateVariableType }>): BoilerplateConfig => ({
    variables: vars.map(v => ({
      name: v.name,
      type: v.type,
      description: '',
      default: '',
      required: false,
    })),
  })

  it('builds map from form data using config types', () => {
    const config = makeConfig([
      { name: 'region', type: BoilerplateVariableType.String },
      { name: 'count', type: BoilerplateVariableType.Int },
      { name: 'enable', type: BoilerplateVariableType.Bool },
    ])
    const formData = { region: 'us-east-1', count: '5', enable: true }

    const result = buildHclInputsMap(formData, config)

    expect(result).toEqual({
      region: '"us-east-1"',
      count: '5',
      enable: 'true',
    })
  })

  it('defaults to string type when variable not in config', () => {
    const config = makeConfig([])
    const formData = { unknown_var: 'hello' }

    const result = buildHclInputsMap(formData, config)

    expect(result).toEqual({
      unknown_var: '"hello"',
    })
  })

  it('handles null config gracefully', () => {
    const formData = { name: 'value' }

    const result = buildHclInputsMap(formData, null)

    expect(result).toEqual({
      name: '"value"',
    })
  })

  it('handles empty form data', () => {
    const config = makeConfig([
      { name: 'region', type: BoilerplateVariableType.String },
    ])

    const result = buildHclInputsMap({}, config)

    expect(result).toEqual({})
  })

  it('handles mixed types correctly', () => {
    const config = makeConfig([
      { name: 'name', type: BoilerplateVariableType.String },
      { name: 'tags', type: BoilerplateVariableType.Map },
      { name: 'cidrs', type: BoilerplateVariableType.List },
      { name: 'port', type: BoilerplateVariableType.Int },
      { name: 'debug', type: BoilerplateVariableType.Bool },
    ])
    const formData = {
      name: 'my-vpc',
      tags: { env: 'prod' },
      cidrs: ['10.0.0.0/16'],
      port: 443,
      debug: false,
    }

    const result = buildHclInputsMap(formData, config)

    expect(result).toEqual({
      name: '"my-vpc"',
      tags: '{"env":"prod"}',
      cidrs: '["10.0.0.0/16"]',
      port: '443',
      debug: 'false',
    })
  })
})
