/**
 * Shared TypeScript interfaces ported from api/types.go.
 */

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

export interface FileData {
  name: string
  path: string
  content: string
  language: string
  size: number
  isTruncated: boolean
}

export interface FileTreeNode {
  id: string
  name: string
  type: "file" | "folder"
  children: FileTreeNode[]
  file?: FileData
}

export interface HeavyDir {
  path: string
  fileCount: number
}

export interface FileTreeMeta {
  totalFiles: number
  truncatedTree: boolean
  heavyDirs: HeavyDir[]
}

export interface FileTreeResult {
  tree: FileTreeNode[]
  meta: FileTreeMeta
}

// ---------------------------------------------------------------------------
// Boilerplate types
// ---------------------------------------------------------------------------

export type BoilerplateVarType =
  | "string"
  | "int"
  | "float"
  | "bool"
  | "list"
  | "map"
  | "enum"

export type BoilerplateValidationType =
  | "required"
  | "url"
  | "email"
  | "alpha"
  | "digit"
  | "alphanumeric"
  | "countrycode2"
  | "semver"
  | "length"
  | "regex"
  | "custom"

export interface ValidationRule {
  type: BoilerplateValidationType
  message: string
  args: unknown[]
}

export interface BoilerplateVariable {
  name: string
  description: string
  type: BoilerplateVarType
  default?: unknown
  required: boolean
  options?: string[]
  validations: ValidationRule[]
  sensitive: boolean
  schema?: Record<string, string>
  schemaInstanceLabel?: string
  sectionName?: string
}

export interface Section {
  name: string
  variables: string[]
}

export interface OutputDependency {
  blockId: string
  outputName: string
  fullPath: string
}

export interface SkipFileRule {
  /**
   * Relative path (from the template root) of the file to conditionally skip.
   *
   * PR3 supports exact-match only — no glob / regex support yet.
   */
  path: string
  /**
   * Optional Go-template expression (rendered against the same `variables`
   * object as the file contents) that decides whether the file is skipped.
   *
   * Truthy → skip. Falsy / empty / "false" / "0" → keep.
   *
   * When `if` is absent the file is always skipped.
   */
  if?: string
}

export interface BoilerplateConfig {
  variables: BoilerplateVariable[]
  sections: Section[]
  outputDependencies: OutputDependency[]
  skipFiles: SkipFileRule[]
}

// ---------------------------------------------------------------------------
// Render types
// ---------------------------------------------------------------------------

export interface RenderRequest {
  templatePath: string
  variables: Record<string, unknown>
  templateId?: string
  outputPath?: string
  target?: "generated" | "worktree"
}

export interface RenderResponse {
  message: string
  outputDir: string
  templatePath: string
  fileTree: FileTreeNode[]
  meta: FileTreeMeta
  deletedFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  skippedFiles: string[]
}

export interface InputValue {
  name: string
  type: BoilerplateVarType
  value: unknown
}

export interface RenderInlineRequest {
  templateFiles: Record<string, string>
  inputs: InputValue[]
  generateFile?: boolean
  outputPath?: string
  target?: "generated" | "worktree"
}

export interface RenderInlineResponse {
  message: string
  renderedFiles: Record<string, FileData>
  fileTree: FileTreeNode[]
  meta: FileTreeMeta
}

// ---------------------------------------------------------------------------
// Boilerplate request
// ---------------------------------------------------------------------------

export interface BoilerplateRequest {
  templatePath?: string
  boilerplateContent?: string
}

// ---------------------------------------------------------------------------
// Generated files types
// ---------------------------------------------------------------------------

export interface GeneratedFilesCheckResponse {
  hasFiles: boolean
  absoluteOutputPath: string
  relativeOutputPath: string
  fileCount: number
}

export interface GeneratedFilesDeleteResponse {
  success: boolean
  deletedCount: number
  message: string
}

// ---------------------------------------------------------------------------
// Execution types
// ---------------------------------------------------------------------------

export interface ExecRequest {
  executableId?: string
  componentId?: string
  templateVarValues?: Record<string, unknown>
  envVarsOverride?: Record<string, string>
}

export interface ExecLogEvent {
  line: string
  timestamp: string
  replace?: boolean
}

export interface ExecStatusEvent {
  status: "success" | "fail" | "warn"
  exitCode: number
}

export interface CapturedFile {
  path: string
  size: number
}

export interface FilesCapturedEvent {
  files: CapturedFile[]
  count: number
  fileTree: unknown
}

export interface BlockOutputsEvent {
  outputs: Record<string, string>
}

// ---------------------------------------------------------------------------
// Executable registry types
// ---------------------------------------------------------------------------

export type ExecutableType = "inline" | "file"

export interface Executable {
  id: string
  type: ExecutableType
  componentId: string
  componentType: string
  content: string
  contentHash: string
  language: string
  path?: string
  templateVars: string[]
}

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export interface SessionMetadata {
  workingDir: string
  executionCount: number
  createdAt: string
  lastActivity: string
  activeTabs: number
}

export interface SessionExecContext {
  env: Record<string, string>
  workDir: string
}

// ---------------------------------------------------------------------------
// Runbook config
// ---------------------------------------------------------------------------

export interface RunbookConfig {
  localPath: string
  remoteSourceURL?: string
  isWatchMode: boolean
  useExecutableRegistry: boolean
}

// ---------------------------------------------------------------------------
// Remote source types
// ---------------------------------------------------------------------------

export interface ParsedRemoteSource {
  host: string
  owner: string
  repo: string
  ref?: string
  path?: string
  cloneURL: string
  isBlobURL: boolean
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export interface WorkspaceTreeNode {
  id: string
  name: string
  type: "file" | "folder"
  size: number
  language: string
  isBinary: boolean
  isIgnored: boolean
  isLazyLoad: boolean
  children: WorkspaceTreeNode[]
}

export interface WorkspaceTreeResponse {
  tree: WorkspaceTreeNode[]
  totalFiles: number
  gitInfo?: {
    ref: string
    refType: string
    remoteUrl?: string
    commitSha?: string
  }
}

export interface WorkspaceFileResponse {
  path: string
  content: string
  language: string
  size: number
  isImage: boolean
  isBinary: boolean
  isTooLarge: boolean
  mimeType?: string
  dataUri?: string
}

export interface WorkspaceFileChange {
  path: string
  changeType: string
  language: string
  additions: number
  deletions: number
  originalContent?: string
  newContent?: string
  isBinary: boolean
  diffTruncated: boolean
}

export interface WorkspaceChangesResponse {
  changes: WorkspaceFileChange[]
  totalChanges: number
  tooManyChanges: boolean
}

// ---------------------------------------------------------------------------
// File manifest types
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  path: string
  contentHash: string
}

export interface TemplateManifest {
  templateId: string
  outputDir: string
  files: ManifestEntry[]
}

export interface ManifestDiffResult {
  orphaned: string[]
  created: string[]
  modified: string[]
  unchanged: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size for inline content (512 KB) */
export const MAX_FILE_CONTENT_SIZE = 512 * 1024

/** Maximum files in file tree response */
export const MAX_FILE_TREE_FILES = 500

/** Heavy directory threshold */
export const HEAVY_DIR_THRESHOLD = 300

/** Maximum workspace files */
export const MAX_WORKSPACE_FILES = 10_000

/** Maximum diff size per file (50 KB) */
export const MAX_DIFF_SIZE_PER_FILE = 50 * 1024

/** Maximum changed files to process */
export const MAX_CHANGED_FILES = 500

/** Maximum directory entries for lazy-loading */
export const MAX_DIR_ENTRIES = 500

/** Maximum tokens per session */
export const MAX_TOKENS_PER_SESSION = 20
