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

/**
 * Checks if a template path is a remote URL.
 * Remote templates are fetched from the network and may take longer to load.
 * 
 * Supports OpenTofu/Terraform-style module source syntax:
 * 
 * **Explicit protocol prefixes:**
 * - `https://` or `http://` - Direct HTTP(S) URLs
 * - `git::` - Git repositories (e.g., git::https://github.com/org/repo//path)
 * - `s3::` - S3 buckets (e.g., s3::https://s3.amazonaws.com/bucket/path)
 * 
 * **Git hosting shorthand (auto-detected):**
 * - `github.com/org/repo` - GitHub repositories
 * - `gitlab.com/org/repo` - GitLab repositories
 * - `bitbucket.org/org/repo` - Bitbucket repositories
 * 
 * All other paths are treated as local paths.
 * 
 * @param path - The template path to check
 * @returns true if the path is a remote URL, false if it's a local path
 * 
 * @example
 * isRemoteTemplatePath("github.com/gruntwork-io/repo//templates/vpc") // true (shorthand)
 * isRemoteTemplatePath("git::https://github.com/org/repo//templates") // true (explicit)
 * isRemoteTemplatePath("https://example.com/template.tar.gz") // true
 * isRemoteTemplatePath("s3::https://s3.amazonaws.com/bucket/template") // true
 * isRemoteTemplatePath("./templates/vpc") // false
 * isRemoteTemplatePath("templates/vpc") // false
 */
export function isRemoteTemplatePath(path: string | undefined | null): boolean {
  if (!path) {
    return false
  }
  
  // Explicit protocol prefixes for remote templates
  const remoteProtocols = [
    'https://',
    'http://',
    'git::',
    's3::',
  ]
  
  if (remoteProtocols.some(prefix => path.startsWith(prefix))) {
    return true
  }
  
  // Git hosting shorthand (matches OpenTofu/Terraform behavior)
  const gitHostingShorthands = [
    'github.com/',
    'gitlab.com/',
    'bitbucket.org/',
  ]
  
  return gitHostingShorthands.some(prefix => path.startsWith(prefix))
}
