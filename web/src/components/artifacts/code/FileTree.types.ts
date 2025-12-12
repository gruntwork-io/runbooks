/**
 * @fileoverview FileTree Types and Schemas
 * 
 * Zod schemas and TypeScript types for the file tree data structures.
 * These are used to validate data from the backend API before use.
 */

import { z } from 'zod'

/**
 * Zod schema for a file with its content and metadata.
 */
export const FileSchema = z.object({
  /** Display name of the file */
  name: z.string(),
  /** Full path of the file */
  path: z.string(),
  /** File content */
  content: z.string(),
  /** Programming language for syntax highlighting */
  language: z.string(),
  /** File size in bytes */
  size: z.number(),
})

/**
 * Represents a file with its content and metadata.
 */
export type File = z.infer<typeof FileSchema>

/**
 * Represents a file or folder in the file tree structure.
 * This interface defines the hierarchical data structure used by FileTree.
 */
export interface FileTreeNode {
  /** Unique identifier for the file/folder */
  id: string;
  /** Display name of the file/folder */
  name: string;
  /** Type of the item - either 'file' or 'folder' */
  type: 'file' | 'folder';
  /** Child items (only present for folders) */
  children?: FileTreeNode[];
  /** File data (only present for files) */
  file?: File;
}

/**
 * Zod schema for a file or folder in the file tree structure.
 * Uses z.lazy() to handle recursive children.
 */
export const FileTreeNodeSchema: z.ZodType<FileTreeNode> = z.lazy(() =>
  z.object({
    /** Unique identifier for the file/folder */
    id: z.string(),
    /** Display name of the file/folder */
    name: z.string(),
    /** Type of the item - either 'file' or 'folder' */
    type: z.enum(['file', 'folder']),
    /** Child items (only present for folders) */
    children: z.array(FileTreeNodeSchema).optional(),
    /** File data (only present for files) */
    file: FileSchema.optional(),
  })
)

/**
 * Zod schema for an array of FileTreeNode items.
 */
export const FileTreeNodeArraySchema = z.array(FileTreeNodeSchema)

/**
 * Safely parse an unknown value as a FileTreeNode array.
 * Returns the validated array or null if validation fails.
 */
export function parseFileTreeNodeArray(value: unknown): FileTreeNode[] | null {
  const result = FileTreeNodeArraySchema.safeParse(value)
  return result.success ? result.data : null
}
