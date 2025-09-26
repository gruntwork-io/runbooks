import { describe, it, expect } from 'vitest'
import { getDirectoryPath } from './utils'

describe('getDirectoryPath', () => {
  it('should extract directory path from file path with extension', () => {
    expect(getDirectoryPath('/path/to/runbook.mdx')).toBe('/path/to')
    expect(getDirectoryPath('/some/file.txt')).toBe('/some')
    expect(getDirectoryPath('/root/document.pdf')).toBe('/root')
  })

  it('should extract directory path from file path without extension', () => {
    expect(getDirectoryPath('/path/to/file')).toBe('/path/to')
    expect(getDirectoryPath('/some/document')).toBe('/some')
  })

  it('should handle root directory files', () => {
    expect(getDirectoryPath('/file.txt')).toBe('/')
    expect(getDirectoryPath('/document')).toBe('/')
  })


  it('should handle nested paths', () => {
    expect(getDirectoryPath('/a/b/c/d/file.txt')).toBe('/a/b/c/d')
    expect(getDirectoryPath('/deeply/nested/path/structure/file.mdx')).toBe('/deeply/nested/path/structure')
  })

  it('should handle paths with multiple dots', () => {
    expect(getDirectoryPath('/path/to/file.backup.txt')).toBe('/path/to')
    expect(getDirectoryPath('/some/config.d.ts')).toBe('/some')
  })

  it('should handle paths with special characters', () => {
    expect(getDirectoryPath('/path/to/file with spaces.txt')).toBe('/path/to')
    expect(getDirectoryPath('/path/to/file-with-dashes.txt')).toBe('/path/to')
    expect(getDirectoryPath('/path/to/file_with_underscores.txt')).toBe('/path/to')
  })

  it('should return undefined for falsy inputs', () => {
    expect(getDirectoryPath('')).toBeUndefined()
    expect(getDirectoryPath(null)).toBeUndefined()
    expect(getDirectoryPath(undefined)).toBeUndefined()
  })

  it('should handle edge cases', () => {
    // Single character file (extract directory)
    expect(getDirectoryPath('/a')).toBe('/')
    
    // Path with only slashes
    expect(getDirectoryPath('///')).toBe('//')
    
    // Path ending with slash (extract directory)
    expect(getDirectoryPath('/path/to/')).toBe('/path/to')
    
    // Single character without path separator (no directory to extract, returns empty string)
    expect(getDirectoryPath('a')).toBe('')
  })

  it('should handle Windows-style paths', () => {
    expect(getDirectoryPath('C:\\path\\to\\file.txt')).toBe('C:\\path\\to')
    expect(getDirectoryPath('D:\\documents\\file.pdf')).toBe('D:\\documents')
  })

  it('should handle relative paths', () => {
    expect(getDirectoryPath('relative/path/file.txt')).toBe('relative/path')
    expect(getDirectoryPath('./local/file.txt')).toBe('./local')
    expect(getDirectoryPath('../parent/file.txt')).toBe('../parent')
  })
})
