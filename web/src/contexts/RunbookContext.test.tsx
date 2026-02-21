import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RunbookContextProvider } from './RunbookContext'
import { useRunbookContext } from './useRunbook'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'
import { makeConfig } from '@/test/make-config'

function createWrapper(props?: { remoteSource?: string; runbookName?: string }) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RunbookContextProvider
        runbookName={props?.runbookName}
        remoteSource={props?.remoteSource}
      >
        {children}
      </RunbookContextProvider>
    )
  }
}

describe('RunbookContext', () => {
  describe('remoteSource', () => {
    it('provides remoteSource from provider props', () => {
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper({ remoteSource: 'https://github.com/org/repo' }),
      })
      expect(result.current.remoteSource).toBe('https://github.com/org/repo')
    })

    it('provides undefined remoteSource when not set', () => {
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })
      expect(result.current.remoteSource).toBeUndefined()
    })
  })

  describe('registerInputs and getInputs', () => {
    it('registers and retrieves inputs with correct types', () => {
      const config = makeConfig([
        { name: 'region', type: BoilerplateVariableType.String },
        { name: 'count', type: BoilerplateVariableType.Int },
      ])
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs('test-form', { region: 'us-west-2', count: 3 }, config)
      })

      const inputs = result.current.getInputs('test-form')
      expect(inputs).toEqual([
        { name: 'region', type: BoilerplateVariableType.String, value: 'us-west-2' },
        { name: 'count', type: BoilerplateVariableType.Int, value: 3 },
      ])
    })

    it('includes extra values not in config as Map type', () => {
      const config = makeConfig([
        { name: 'region', type: BoilerplateVariableType.String },
      ])
      const moduleData = {
        source: 'github.com/org/module',
        hcl_inputs: { region: '"us-west-2"' },
      }
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs(
          'module-vars',
          { region: 'us-west-2', _module: moduleData },
          config,
        )
      })

      const inputs = result.current.getInputs('module-vars')

      // Should include the config variable with its declared type
      const regionInput = inputs.find(i => i.name === 'region')
      expect(regionInput).toEqual({
        name: 'region',
        type: BoilerplateVariableType.String,
        value: 'us-west-2',
      })

      // Should include _module as Map type (extra value not in config)
      const moduleInput = inputs.find(i => i.name === '_module')
      expect(moduleInput).toBeDefined()
      expect(moduleInput!.type).toBe(BoilerplateVariableType.Map)
      expect(moduleInput!.value).toEqual(moduleData)
    })

    it('extra values do not override config variables', () => {
      const config = makeConfig([
        { name: 'name', type: BoilerplateVariableType.String },
      ])
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs('form', { name: 'hello', extra: 'world' }, config)
      })

      const inputs = result.current.getInputs('form')

      // 'name' should keep its String type from config, not become Map
      const nameInput = inputs.find(i => i.name === 'name')
      expect(nameInput!.type).toBe(BoilerplateVariableType.String)

      // 'extra' should be added as Map type
      const extraInput = inputs.find(i => i.name === 'extra')
      expect(extraInput!.type).toBe(BoilerplateVariableType.Map)
    })
  })

  describe('getInputs with multiple inputsIds', () => {
    it('merges inputs from multiple blocks', () => {
      const config1 = makeConfig([
        { name: 'region', type: BoilerplateVariableType.String },
      ])
      const config2 = makeConfig([
        { name: 'count', type: BoilerplateVariableType.Int },
      ])
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs('form-a', { region: 'us-west-2' }, config1)
        result.current.registerInputs('form-b', { count: 5 }, config2)
      })

      const inputs = result.current.getInputs(['form-a', 'form-b'])
      const names = inputs.map(i => i.name).sort()
      expect(names).toEqual(['count', 'region'])
    })

    it('later IDs override earlier ones for same variable', () => {
      const config = makeConfig([
        { name: 'region', type: BoilerplateVariableType.String },
      ])
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs('form-a', { region: 'us-east-1' }, config)
        result.current.registerInputs('form-b', { region: 'us-west-2' }, config)
      })

      const inputs = result.current.getInputs(['form-a', 'form-b'])
      const regionInput = inputs.find(i => i.name === 'region')
      expect(regionInput!.value).toBe('us-west-2')
    })
  })

  describe('getTemplateVariables', () => {
    it('spreads input values at root level', () => {
      const config = makeConfig([
        { name: 'region', type: BoilerplateVariableType.String },
      ])
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs('form', { region: 'us-west-2' }, config)
      })

      const vars = result.current.getTemplateVariables('form')
      expect(vars.region).toBe('us-west-2')
    })

    it('includes _module namespace in template variables', () => {
      const config = makeConfig([
        { name: 'bucket_name', type: BoilerplateVariableType.String },
      ])
      const moduleData = {
        source: './my-module',
        hcl_inputs: { bucket_name: '"my-bucket"' },
      }
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs(
          'module-vars',
          { bucket_name: 'my-bucket', _module: moduleData },
          config,
        )
      })

      const vars = result.current.getTemplateVariables('module-vars')
      expect(vars.bucket_name).toBe('my-bucket')
      expect(vars._module).toEqual(moduleData)
    })

    it('includes _blocks namespace with block outputs', () => {
      const config = makeConfig([])
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs('form', {}, config)
        result.current.registerOutputs('create-account', { account_id: '123' })
      })

      const vars = result.current.getTemplateVariables('form')
      const blocks = vars._blocks as Record<string, { outputs: Record<string, string> }>

      // Block IDs are normalized (hyphens → underscores)
      expect(blocks['create_account']).toBeDefined()
      expect(blocks['create_account'].outputs.account_id).toBe('123')
    })
  })

  describe('registerInputs change detection', () => {
    it('does not trigger re-render when values are unchanged', () => {
      const config = makeConfig([
        { name: 'region', type: BoilerplateVariableType.String },
      ])
      const { result } = renderHook(() => useRunbookContext(), {
        wrapper: createWrapper(),
      })

      act(() => {
        result.current.registerInputs('form', { region: 'us-west-2' }, config)
      })

      const blockInputsBefore = result.current.blockInputs

      act(() => {
        // Register same values again
        result.current.registerInputs('form', { region: 'us-west-2' }, config)
      })

      // blockInputs reference should not change (shallow equality optimization)
      expect(result.current.blockInputs).toBe(blockInputsBefore)
    })
  })
})
