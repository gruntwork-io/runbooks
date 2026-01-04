import { describe, it, expect } from 'vitest'
import { 
  stripAnsi, 
  parseLogLine, 
  parseLogsToStructured,
  generateLogFilename,
} from './logs'

// =============================================================================
// Log Export Utilities Tests
// =============================================================================

describe('stripAnsi', () => {
  it('should strip color codes', () => {
    expect(stripAnsi('\x1b[32mgreen text\x1b[0m')).toBe('green text')
    expect(stripAnsi('\x1b[31mred\x1b[0m and \x1b[34mblue\x1b[0m')).toBe('red and blue')
  })

  it('should strip various ANSI escape sequences', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[0m')).toBe('bold')
    expect(stripAnsi('\x1b[4munderline\x1b[0m')).toBe('underline')
    expect(stripAnsi('\x1b[38;5;196mextended color\x1b[0m')).toBe('extended color')
  })

  it('should return text unchanged if no ANSI codes', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
    expect(stripAnsi('')).toBe('')
  })

  it('should preserve emojis and unicode', () => {
    expect(stripAnsi('✅ success')).toBe('✅ success')
    expect(stripAnsi('\x1b[32m✅ success\x1b[0m')).toBe('✅ success')
  })
})

describe('parseLogLine', () => {
  const fallbackTs = '2026-01-04T10:00:00Z'

  it('should parse full format: [TIMESTAMP] [LEVEL] Message', () => {
    const result = parseLogLine('[2026-01-04T12:30:00Z] [INFO]  Hello world', fallbackTs)
    expect(result).toEqual({
      timestamp: '2026-01-04T12:30:00Z',
      level: 'INFO',
      message: 'Hello world',
    })
  })

  it('should parse short format: [LEVEL] Message', () => {
    const result = parseLogLine('[INFO]  Hello world', fallbackTs)
    expect(result).toEqual({
      timestamp: fallbackTs,
      level: 'INFO',
      message: 'Hello world',
    })
  })

  it('should handle all log levels in short format', () => {
    expect(parseLogLine('[INFO] test', fallbackTs)?.level).toBe('INFO')
    expect(parseLogLine('[WARN] test', fallbackTs)?.level).toBe('WARN')
    expect(parseLogLine('[ERROR] test', fallbackTs)?.level).toBe('ERROR')
    expect(parseLogLine('[DEBUG] test', fallbackTs)?.level).toBe('DEBUG')
  })

  it('should normalize level to uppercase', () => {
    expect(parseLogLine('[info] test', fallbackTs)?.level).toBe('INFO')
    expect(parseLogLine('[Warn] test', fallbackTs)?.level).toBe('WARN')
  })

  it('should return null for non-matching lines', () => {
    expect(parseLogLine('Just plain text', fallbackTs)).toBeNull()
    expect(parseLogLine('=========', fallbackTs)).toBeNull()
    expect(parseLogLine('', fallbackTs)).toBeNull()
  })

  it('should strip ANSI codes before parsing', () => {
    const result = parseLogLine('\x1b[32m[INFO]  Green message\x1b[0m', fallbackTs)
    expect(result).toEqual({
      timestamp: fallbackTs,
      level: 'INFO',
      message: 'Green message',
    })
  })
})

describe('parseLogsToStructured', () => {
  const blockId = 'test-block'

  it('should parse logs with short format', () => {
    const logs = [
      { line: '[INFO]  First message', timestamp: '2026-01-04T10:00:00Z' },
      { line: '[WARN]  Warning message', timestamp: '2026-01-04T10:00:01Z' },
      { line: '[ERROR] Error message', timestamp: '2026-01-04T10:00:02Z' },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      timestamp: '2026-01-04T10:00:00Z',
      level: 'INFO',
      message: 'First message',
      block_id: blockId,
    })
    expect(result[1].level).toBe('WARN')
    expect(result[2].level).toBe('ERROR')
  })

  it('should parse logs with full format', () => {
    const logs = [
      { line: '[2026-01-04T12:00:00Z] [INFO]  Message', timestamp: '2026-01-04T10:00:00Z' },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    expect(result).toHaveLength(1)
    expect(result[0].timestamp).toBe('2026-01-04T12:00:00Z') // Uses timestamp from log line
  })

  it('should handle multi-line content in a single LogEntry', () => {
    const logs = [
      { 
        line: '[INFO]  First\n[WARN]  Second\n[ERROR] Third', 
        timestamp: '2026-01-04T10:00:00Z' 
      },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    expect(result).toHaveLength(3)
    expect(result[0].level).toBe('INFO')
    expect(result[0].message).toBe('First')
    expect(result[1].level).toBe('WARN')
    expect(result[2].level).toBe('ERROR')
  })

  it('should append non-matching lines to previous entry', () => {
    const logs = [
      { line: '[INFO]  Starting process', timestamp: '2026-01-04T10:00:00Z' },
      { line: '  Additional detail line 1', timestamp: '2026-01-04T10:00:01Z' },
      { line: '  Additional detail line 2', timestamp: '2026-01-04T10:00:02Z' },
      { line: '[INFO]  Next entry', timestamp: '2026-01-04T10:00:03Z' },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    expect(result).toHaveLength(2)
    expect(result[0].message).toBe('Starting process\n  Additional detail line 1\n  Additional detail line 2')
    expect(result[1].message).toBe('Next entry')
  })

  it('should create INFO entry for non-matching lines at start', () => {
    const logs = [
      { line: '=========', timestamp: '2026-01-04T10:00:00Z' },
      { line: '  Banner text', timestamp: '2026-01-04T10:00:01Z' },
      { line: '=========', timestamp: '2026-01-04T10:00:02Z' },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    expect(result).toHaveLength(1)
    expect(result[0].level).toBe('INFO')
    expect(result[0].message).toBe('=========\n  Banner text\n=========')
  })

  it('should skip empty lines', () => {
    const logs = [
      { line: '[INFO]  Message 1\n\n[INFO]  Message 2', timestamp: '2026-01-04T10:00:00Z' },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    expect(result).toHaveLength(2)
  })

  it('should handle complex real-world logging demo output', () => {
    const logs = [
      {
        line: '=========================================\n  Runbooks Logging Demo\n=========================================\n\n[INFO]  This is an informational message\n[WARN]  This is a warning message\n[ERROR] This is an error message',
        timestamp: '2026-01-04T10:00:00Z',
      },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    // Should have: banner (INFO), INFO message, WARN message, ERROR message
    expect(result.length).toBeGreaterThanOrEqual(3)
    
    // Find the actual log messages
    const infoEntry = result.find(r => r.level === 'INFO' && r.message.includes('informational'))
    const warnEntry = result.find(r => r.level === 'WARN')
    const errorEntry = result.find(r => r.level === 'ERROR')
    
    expect(infoEntry).toBeDefined()
    expect(infoEntry?.message).toBe('This is an informational message')
    expect(warnEntry).toBeDefined()
    expect(warnEntry?.message).toBe('This is a warning message')
    expect(errorEntry).toBeDefined()
    expect(errorEntry?.message).toBe('This is an error message')
  })

  it('should preserve emojis in messages', () => {
    const logs = [
      { line: '[INFO]  ✅ Success!', timestamp: '2026-01-04T10:00:00Z' },
      { line: '[ERROR] ❌ Failed!', timestamp: '2026-01-04T10:00:01Z' },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    expect(result[0].message).toBe('✅ Success!')
    expect(result[1].message).toBe('❌ Failed!')
  })

  it('should strip ANSI codes from output', () => {
    const logs = [
      { line: '\x1b[32m[INFO]  Colored message\x1b[0m', timestamp: '2026-01-04T10:00:00Z' },
    ]
    
    const result = parseLogsToStructured(logs, blockId)
    
    expect(result[0].message).toBe('Colored message')
  })
})

describe('generateLogFilename', () => {
  it('should generate filename with correct format', () => {
    const filename = generateLogFilename('my-block', 'log')
    
    expect(filename).toMatch(/^runbook-my-block-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.*\.log$/)
  })

  it('should handle different extensions', () => {
    expect(generateLogFilename('block', 'log')).toContain('.log')
    expect(generateLogFilename('block', 'json')).toContain('.json')
  })
})

