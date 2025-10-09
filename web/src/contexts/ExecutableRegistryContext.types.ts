import { createContext } from 'react'
import { type Executable, type ExecutableRegistry } from '@/types/executable'
import { type AppError } from '@/types/error'

export interface ExecutableRegistryContextValue {
  registry: ExecutableRegistry | null
  loading: boolean
  error: AppError | null
  getExecutableByComponentId: (componentId: string) => Executable | null
}

export const ExecutableRegistryContext = createContext<ExecutableRegistryContextValue | undefined>(undefined)
