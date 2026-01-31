/**
 * Log utilities for parsing, formatting, and exporting execution logs.
 */

// =============================================================================
// ANSI Processing
// =============================================================================

/**
 * Regular expression to match ANSI escape codes.
 * Matches:
 * - CSI sequences: ESC [ ... letter (colors, cursor, etc.)
 * - OSC sequences: ESC ] ... ST (titles, hyperlinks, etc.)
 * - Character set designation: ESC ( X, ESC ) X, etc. (e.g., from tput sgr0)
 * - Simple escapes: ESC followed by single char
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*(?:\x07|\x1b\\)|\][^\x1b]*|[()*/+\-].|[a-zA-Z])/g

/**
 * Strips ANSI escape codes from text.
 * Useful for exporting/copying clean log text.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

// =============================================================================
// Log Parsing
// =============================================================================

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

// =============================================================================
// File Download Utilities
// =============================================================================

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
  downloadBlob(blob, filename)
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

// =============================================================================
// Zip Export Utilities
// =============================================================================

import JSZip from 'jszip'

/** Log entry type (matches useApiExec.LogEntry) */
interface LogEntry {
  line: string
  timestamp: string
}

/**
 * Downloads a Blob as a file.
 * 
 * @param blob - The Blob to download
 * @param filename - The name for the downloaded file
 */
export function downloadBlob(blob: Blob, filename: string): void {
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
 * Creates a zip file containing raw log files for each block.
 * Each file is named {blockId}.log and contains plain text logs with ANSI codes stripped.
 * 
 * @param logsMap - Map of blockId to LogEntry arrays
 * @returns Promise resolving to a Blob containing the zip file
 */
export async function createLogsZipRaw(logsMap: Map<string, LogEntry[]>): Promise<Blob> {
  const zip = new JSZip()
  
  for (const [blockId, logs] of logsMap) {
    if (logs.length === 0) continue
    
    // Convert logs to plain text with ANSI codes stripped
    const plainText = logs.map(log => stripAnsi(log.line)).join('\n')
    zip.file(`${blockId}.log`, plainText)
  }
  
  return zip.generateAsync({ type: 'blob' })
}

/**
 * Creates a zip file containing structured JSON log files for each block.
 * Each file is named {blockId}.json and contains parsed, structured log entries.
 * 
 * @param logsMap - Map of blockId to LogEntry arrays
 * @returns Promise resolving to a Blob containing the zip file
 */
export async function createLogsZipJson(logsMap: Map<string, LogEntry[]>): Promise<Blob> {
  const zip = new JSZip()
  
  for (const [blockId, logs] of logsMap) {
    if (logs.length === 0) continue
    
    // Parse logs to structured format
    const structured = parseLogsToStructured(logs, blockId)
    const json = JSON.stringify(structured, null, 2)
    zip.file(`${blockId}.json`, json)
  }
  
  return zip.generateAsync({ type: 'blob' })
}

/**
 * Generates a filename for the all-logs zip export.
 * Format: runbook-logs-{timestamp}.zip
 * 
 * @returns The generated filename
 */
export function generateAllLogsZipFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `runbook-logs-${timestamp}.zip`
}
