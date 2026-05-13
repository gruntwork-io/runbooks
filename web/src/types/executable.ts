export interface Executable {
  id: string
  type: 'inline' | 'file'
  componentId: string
  componentType: 'check' | 'command'
  contentHash: string
  path?: string
  templateVars?: string[]
  language?: string
}

export type ExecutableRegistry = Record<string, Executable>

export interface ExecutableRegistryResponse {
  executables: ExecutableRegistry
  warnings: string[]
}
