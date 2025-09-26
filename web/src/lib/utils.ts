/* Added by shadcn/ui install script */
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Extracts the directory path from a file path by removing the filename.
 * Returns undefined if the input is falsy.
 * 
 * @param filePath - The full file path (e.g., "/path/to/file.txt")
 * @returns The directory path (e.g., "/path/to") or undefined if input is falsy
 * 
 * @example
 * getDirectoryPath("/path/to/runbook.mdx") // returns "/path/to"
 * getDirectoryPath("/some/file.txt") // returns "/some"
 * getDirectoryPath("/root") // returns "/"
 * getDirectoryPath("") // returns undefined
 * getDirectoryPath(null) // returns undefined
 */
export function getDirectoryPath(filePath: string | null | undefined): string | undefined {
  if (!filePath) {
    return undefined
  }
  
  // Handle Windows-style paths
  if (filePath.includes('\\')) {
    const result = filePath.replace(/\\[^\\]*$/, '')
    return result || undefined
  }
  
  // Handle Unix-style paths
  const result = filePath.replace(/\/[^/]*$/, '')
  
  // If the result is empty and the original path started with '/', return '/'
  if (result === '' && filePath.startsWith('/')) {
    return '/'
  }
  
  // If no path separators were found, return empty string
  if (result === filePath) {
    return ''
  }
  
  return result || undefined
}
