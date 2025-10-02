import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/**
 * Execution status for Check and Command components
 * - pending: Not yet executed
 * - running: Currently executing
 * - success: Execution completed successfully (exit code 0)
 * - warn: For the Check component only - completed with warning (exit code 1)
 * - fail: Execution failed (exit code 2+ for Check component, non-zero for Command component)
 */
export type ExecutionStatus = 'success' | 'warn' | 'fail' | 'running' | 'pending'

/**
 * Component type for execution-based components
 */
export type ComponentType = 'check' | 'command'

/**
 * Base props shared by Check and Command components
 */
export interface BaseExecutionProps {
  id: string
  path?: string
  command?: string
  boilerplateInputsId?: string
  successMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode
}

/**
 * Status icon configuration
 */
export interface StatusIconConfig {
  icon: LucideIcon
  className: string
  animate?: boolean
}

/**
 * Status styling configuration
 */
export interface StatusStyling {
  containerClasses: string
  iconClasses: string
}

