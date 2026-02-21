import { BoilerplateVariableType } from '@/types/boilerplateVariable'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

/**
 * Creates a minimal BoilerplateConfig from a list of variable name/type pairs.
 * Useful for tests that need a config but don't care about descriptions/defaults.
 */
export const makeConfig = (vars: Array<{ name: string; type: BoilerplateVariableType }>): BoilerplateConfig => ({
  variables: vars.map(v => ({
    name: v.name,
    type: v.type,
    description: '',
    default: '',
    required: false,
  })),
})
