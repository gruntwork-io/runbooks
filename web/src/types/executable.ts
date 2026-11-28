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
  /** The block's `env` prop: its variables' templates by name. */
  env?: Record<string, string>
  /** The block's `envFrom` prop: the auth blocks whose exports its script runs with. */
  envFrom?: readonly string[]
  /** The block's `workingDir` prop, or "" for the session's directory. */
  workingDir: string
  /** The block's `interpreter` prop, or "" for none. */
  interpreter: string
}

export type ExecutableRegistry = Record<string, Executable>
