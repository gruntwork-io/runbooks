/* Added by shadcn/ui install script */
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { FileTreeNode } from '../components/artifacts/code/FileTree'
import copy from "copy-to-clipboard"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Copies text to the clipboard.
 *
 * - Prefer modern Clipboard API when available
 * - Fall back to `copy-to-clipboard` for broader compatibility
 *
 * @returns true if the copy likely succeeded, false otherwise
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // Modern Clipboard API (async)
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy fallback
  }

  // Legacy fallback (sync) via library
  try {
    return copy(text)
  } catch {
    return false
  }
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

/**
 * Checks if a file tree contains any generated files.
 * Recursively traverses the tree to find files with content.
 * 
 * @param fileTree - The file tree to check (can be null/undefined or an array of nodes)
 * @returns true if any files exist in the tree, false otherwise
 */
export function hasGeneratedFiles(fileTree: FileTreeNode[] | null | undefined): boolean {
  if (!fileTree || fileTree.length === 0) {
    return false
  }
  
  const traverse = (nodes: FileTreeNode[]): boolean => {
    for (const node of nodes) {
      // Check if this is a file node with content
      if (node.type === 'file' && node.file) {
        return true
      }
      // Recursively check children
      if (node.children && node.children.length > 0) {
        if (traverse(node.children)) {
          return true
        }
      }
    }
    return false
  }
  
  return traverse(fileTree)
}

// =============================================================================
// Log Export Utilities
// =============================================================================

/**
 * Regular expression to match ANSI escape codes.
 * Matches color codes, cursor movement, and other terminal escape sequences.
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g

/**
 * Strips ANSI escape codes from text.
 * Useful for exporting/copying clean log text.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

/**
 * Structured log entry for JSON export.
 */
export interface StructuredLogEntry {
  timestamp: string
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | string
  message: string
  block_id: string
}

/**
 * Regular expression to parse full log format: [TIMESTAMP] [LEVEL] Message
 * Matches lines like: [2024-01-15T10:30:00Z] [INFO]  Some message
 */
const LOG_LINE_FULL_REGEX = /^\[(?<ts>[^\]]+)\]\s+\[(?<level>[^\]]+)\]\s*(?<msg>.*)$/

/**
 * Regular expression to parse short log format: [LEVEL] Message
 * Matches lines like: [INFO]  Some message
 * Level must be a known log level to avoid matching timestamps
 */
const LOG_LINE_SHORT_REGEX = /^\[(?<level>INFO|WARN|ERROR|DEBUG)\]\s*(?<msg>.*)$/i

/**
 * Parses a single line and returns structured data if it matches a log format.
 * Returns null if the line doesn't match any known format.
 */
export function parseLogLine(
  line: string,
  fallbackTimestamp: string
): { timestamp: string; level: string; message: string } | null {
  const cleanLine = stripAnsi(line)
  
  // Try full format first: [TIMESTAMP] [LEVEL] Message
  const fullMatch = LOG_LINE_FULL_REGEX.exec(cleanLine)
  if (fullMatch?.groups) {
    return {
      timestamp: fullMatch.groups.ts,
      level: fullMatch.groups.level.trim().toUpperCase(),
      message: fullMatch.groups.msg,
    }
  }
  
  // Try short format: [LEVEL] Message
  const shortMatch = LOG_LINE_SHORT_REGEX.exec(cleanLine)
  if (shortMatch?.groups) {
    return {
      timestamp: fallbackTimestamp,
      level: shortMatch.groups.level.toUpperCase(),
      message: shortMatch.groups.msg,
    }
  }
  
  return null
}

/**
 * Parses raw log entries into structured JSON format.
 * 
 * Handles multiple scenarios:
 * - Full format: [TIMESTAMP] [LEVEL] Message
 * - Short format: [LEVEL] Message (uses LogEntry timestamp)
 * - Multi-line content within a single LogEntry (splits by newline)
 * - Non-matching lines are appended to previous entry or create INFO entry
 * 
 * @param logs - Array of log entries with line and timestamp
 * @param blockId - The block ID to include in each structured entry
 * @returns Array of structured log entries
 */
export function parseLogsToStructured(
  logs: { line: string; timestamp: string }[],
  blockId: string
): StructuredLogEntry[] {
  const result: StructuredLogEntry[] = []

  for (const log of logs) {
    // Split the log line by newlines to handle multi-line content
    const lines = log.line.split('\n')
    
    for (const line of lines) {
      const cleanLine = stripAnsi(line)
      
      // Skip empty lines
      if (!cleanLine.trim()) {
        continue
      }
      
      const parsed = parseLogLine(line, log.timestamp)

      if (parsed) {
        // Line matches a known log format
        result.push({
          timestamp: parsed.timestamp,
          level: parsed.level,
          message: parsed.message,
          block_id: blockId,
        })
      } else {
        // Non-matching line: append to previous entry or create new INFO entry
        if (result.length > 0) {
          result[result.length - 1].message += '\n' + cleanLine
        } else {
          result.push({
            timestamp: log.timestamp,
            level: 'INFO',
            message: cleanLine,
            block_id: blockId,
          })
        }
      }
    }
  }

  return result
}

/**
 * Triggers a client-side file download using Blob and URL.createObjectURL.
 * Preserves UTF-8 encoding to correctly render emojis in downloaded files.
 * 
 * @param content - The file content to download
 * @param filename - The name for the downloaded file
 * @param mimeType - The MIME type (e.g., 'text/plain', 'application/json')
 */
export function downloadFile(
  content: string,
  filename: string,
  mimeType: string
): void {
  // Ensure UTF-8 charset for proper emoji support
  const blob = new Blob([content], { type: `${mimeType}; charset=utf-8` })
  const url = URL.createObjectURL(blob)
  
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  
  // Cleanup
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Generates a filename for log exports.
 * Format: runbook-{blockId}-{timestamp}.{ext}
 * 
 * @param blockId - The block ID
 * @param extension - The file extension (e.g., 'log', 'json')
 * @returns The generated filename
 */
export function generateLogFilename(blockId: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `runbook-${blockId}-${timestamp}.${extension}`
}
