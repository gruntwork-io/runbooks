import { createContext } from 'react'
import { type Executable, type ExecutableRegistry } from '@/types/executable'
import { type AppError } from '@/types/error'

export interface ExecutableRegistryContextValue {
  registry: ExecutableRegistry | null
  warnings: string[]
  loading: boolean
  error: AppError | null
  useExecutableRegistry: boolean
  getExecutableByComponentId: (componentId: string) => Executable | null
}

export const ExecutableRegistryContext = createContext<ExecutableRegistryContextValue | undefined>(undefined)
