export interface Executable {
  id: string
  type: 'inline' | 'file'
  component_id: string
  component_type: 'check' | 'command'
  script_path?: string
  template_var_names?: string[]
  language?: string
}

export type ExecutableRegistry = Record<string, Executable>

export interface ExecutableRegistryResponse {
  executables: ExecutableRegistry
  warnings: string[]
}

