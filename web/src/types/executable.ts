export interface Executable {
  id: string
  type: 'inline' | 'file'
  componentId: string
  /** The block type, lowercased by the registry (a <Finish> registers as 'finish'). */
  componentType: 'check' | 'command' | 'finish'
  contentHash: string
  path?: string
  templateVars?: string[]
  language?: string
}

export type ExecutableRegistry = Record<string, Executable>
