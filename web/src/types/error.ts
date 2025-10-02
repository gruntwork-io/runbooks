/**
 * Standard error type used throughout the application
 */
export interface AppError {
  message: string;
  details: string;
}

/**
 * Factory function to create an AppError with optional details
 */
export function createAppError(message: string, details?: string): AppError {
  return {
    message,
    details: details || ""
  };
}