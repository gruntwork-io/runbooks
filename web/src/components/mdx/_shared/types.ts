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
