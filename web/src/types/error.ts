/**
 * Error codes for typed error handling
 */
export type AppErrorCode = 
  | 'BACKEND_CONNECTION_ERROR'
  | 'REGISTRY_FETCH_FAILED'
  | 'UNKNOWN_ERROR';

/**
 * Standard error type used throughout the application
 */
export interface AppError {
  message: string;
  details: string;
  /** Error code for programmatic error type detection */
  code?: AppErrorCode;
  /** Additional context fields for specific error types */
  context?: {
    specifiedPath?: string;
    currentWorkingDir?: string;
  };
}

/**
 * Factory function to create an AppError with optional details and context
 */
export function createAppError(
  message: string, 
  details?: string,
  context?: AppError['context'],
  code?: AppErrorCode
): AppError {
  return {
    message,
    details: details || "",
    code,
    context
  };
}