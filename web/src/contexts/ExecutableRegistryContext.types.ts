import { createContext } from 'react'
import { type Executable } from '@/types/executable'

export interface ExecutableRegistryContextValue {
  getExecutableByComponentId: (componentId: string) => Executable | null
}

export const ExecutableRegistryContext = createContext<ExecutableRegistryContextValue | undefined>(undefined)
