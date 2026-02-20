/* Added by shadcn/ui install script */
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { FileTreeNode } from '../components/artifacts/code/FileTree'
import copy from "copy-to-clipboard"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Normalizes a block ID to its canonical form.
 * 
 * Go templates don't support hyphens in dot notation (e.g., `._blocks.create-account` fails),
 * so we convert hyphens to underscores. This means "create-account" and "create_account"
 * are treated as the same ID.
 * 
 * IMPORTANT: This normalization must be applied consistently:
 * - When registering block outputs (RunbookContext)
 * - When looking up block outputs (Template, TemplateInline)
 * - When checking for ID collisions (ComponentIdRegistry)
 * - When resolving AWS auth dependencies (useScriptExecution)
 * 
 * The backend (boilerplate_config.go) also normalizes block IDs when extracting
 * output dependencies, ensuring frontend-backend consistency.
 * 
 * @param id - The raw block ID (may contain hyphens)
 * @returns The normalized ID with hyphens replaced by underscores
 */
export function normalizeBlockId(id: string): string {
  if (!id) return ''
  return id.replace(/-/g, '_')
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
