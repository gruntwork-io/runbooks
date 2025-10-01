import { createContext } from 'react'

/**
 * Context for sharing boilerplate variable bindings between BoilerplateInputs and BoilerplateTemplate components.
 * 
 * This context acts as a global registry where BoilerplateInputs components publish their variable values
 * when Generate is clicked, and BoilerplateTemplate components subscribe to those values by matching ID.
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
  setVariables: (inputsId: string, variables: Record<string, unknown>) => void
  getVariables: (inputsId: string) => Record<string, unknown> | undefined
}

export const BoilerplateVariablesContext = createContext<BoilerplateVariablesContextType | undefined>(undefined)

