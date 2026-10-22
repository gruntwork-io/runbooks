export interface Executable {
  id: string
  type: "inline" | "file"
  componentId: string
  /**
   * The block type, lowercased by the registry (a <Finish> registers as
   * "finish"). A <Prerequisites> block's tool list registers as "prerequisites".
   */
  componentType: "check" | "command" | "finish" | "prerequisites"
  contentHash: string
  path?: string
  templateVars?: string[]
  language?: string
}

export type ExecutableRegistry = Record<string, Executable>
