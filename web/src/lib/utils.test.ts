import { describe, it, expect } from 'vitest'
import { getDirectoryPath, isRemoteTemplatePath } from './utils'

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

describe('isRemoteTemplatePath', () => {
  describe('remote paths with explicit prefixes (should return true)', () => {
    it('should detect HTTPS URLs', () => {
      expect(isRemoteTemplatePath('https://github.com/gruntwork-io/repo//templates/vpc')).toBe(true)
      expect(isRemoteTemplatePath('https://github.com/org/repo')).toBe(true)
    })

    it('should detect HTTP URLs', () => {
      expect(isRemoteTemplatePath('http://example.com/templates')).toBe(true)
    })

    it('should detect git:: protocol URLs', () => {
      expect(isRemoteTemplatePath('git::https://github.com/org/repo//templates')).toBe(true)
      expect(isRemoteTemplatePath('git::git@github.com:org/repo.git//templates')).toBe(true)
      expect(isRemoteTemplatePath('git::git@github.com:org/repo.git')).toBe(true)
    })

    it('should detect s3:: protocol URLs', () => {
      expect(isRemoteTemplatePath('s3::https://s3.amazonaws.com/bucket/template')).toBe(true)
      expect(isRemoteTemplatePath('s3::https://s3-us-west-2.amazonaws.com/mybucket/path')).toBe(true)
    })
  })

  describe('Git hosting shorthand (OpenTofu/Terraform style)', () => {
    it('should detect github.com shorthand', () => {
      expect(isRemoteTemplatePath('github.com/gruntwork-io/repo//templates/vpc')).toBe(true)
      expect(isRemoteTemplatePath('github.com/org/repo//path?ref=v1.0.0')).toBe(true)
    })

    it('should detect gitlab.com shorthand', () => {
      expect(isRemoteTemplatePath('gitlab.com/org/repo//templates')).toBe(true)
    })

    it('should detect bitbucket.org shorthand', () => {
      expect(isRemoteTemplatePath('bitbucket.org/org/repo//templates')).toBe(true)
    })
  })

  describe('local paths (should return false)', () => {
    it('should not detect relative paths', () => {
      expect(isRemoteTemplatePath('templates/vpc')).toBe(false)
      expect(isRemoteTemplatePath('./templates/vpc')).toBe(false)
      expect(isRemoteTemplatePath('../templates/vpc')).toBe(false)
    })

    it('should not detect absolute paths', () => {
      expect(isRemoteTemplatePath('/home/user/templates/vpc')).toBe(false)
    })

    it('should not detect Windows-style paths', () => {
      expect(isRemoteTemplatePath('C:\\Users\\templates\\vpc')).toBe(false)
    })

    it('should not detect git@ without git:: prefix', () => {
      expect(isRemoteTemplatePath('git@github.com:org/repo.git//templates')).toBe(false)
      expect(isRemoteTemplatePath('git@github.com:org/repo.git')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('should return false for empty path', () => {
      expect(isRemoteTemplatePath('')).toBe(false)
    })

    it('should return false for null/undefined', () => {
      expect(isRemoteTemplatePath(null)).toBe(false)
      expect(isRemoteTemplatePath(undefined)).toBe(false)
    })

    it('should not match paths that contain but do not start with remote prefixes', () => {
      expect(isRemoteTemplatePath('my-https-template')).toBe(false)
      expect(isRemoteTemplatePath('my-git-template')).toBe(false)
      expect(isRemoteTemplatePath('my-s3-bucket')).toBe(false)
      expect(isRemoteTemplatePath('my-github.com-template')).toBe(false)
    })
  })
})
