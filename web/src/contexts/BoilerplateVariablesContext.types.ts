import { createContext } from 'react'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

/**
 * Context for sharing boilerplate variable bindings and configurations between BoilerplateInputs and BoilerplateTemplate components.
 * 
 * This context acts as a global registry where BoilerplateInputs components publish their variable values
 * and boilerplate configs when loaded, and BoilerplateTemplate components subscribe to those values by matching ID.
 */
export interface BoilerplateVariablesContextType {
  /**
   * A map of variable bindings indexed by BoilerplateInputs component ID.
   * Structure: { "inputs-id": { variableName: value, ... }, ... }
   * 
   * Example:
   * {
   *   "lambda-config": { AccountName: "Dev", Environment: "dev" },
   *   "s3-config": { BucketName: "my-bucket", Region: "us-west-2" }
   * }
   */
  variablesByInputsId: Record<string, Record<string, unknown>>
  
  /**
   * A map of boilerplate configurations indexed by BoilerplateInputs component ID.
   * Structure: { "inputs-id": BoilerplateConfig, ... }
   */
  configsByInputsId: Record<string, BoilerplateConfig>
  
  /**
   * A map of raw boilerplate YAML content indexed by BoilerplateInputs component ID.
   * This stores the original YAML so we don't have to reconstruct it.
   * Structure: { "inputs-id": "yaml content...", ... }
   */
  yamlContentByInputsId: Record<string, string>
  
  setVariables: (inputsId: string, variables: Record<string, unknown>) => void
  getVariables: (inputsId: string) => Record<string, unknown> | undefined
  setConfig: (inputsId: string, config: BoilerplateConfig) => void
  getConfig: (inputsId: string) => BoilerplateConfig | undefined
  setYamlContent: (inputsId: string, yamlContent: string) => void
  getYamlContent: (inputsId: string) => string | undefined
}

export const BoilerplateVariablesContext = createContext<BoilerplateVariablesContextType | undefined>(undefined)

