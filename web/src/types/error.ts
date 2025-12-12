/**
 * Standard error type used throughout the application
 */
export interface AppError {
  message: string;
  details: string;
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
  context?: AppError['context']
): AppError {
  return {
    message,
    details: details || "",
    context
  };
}