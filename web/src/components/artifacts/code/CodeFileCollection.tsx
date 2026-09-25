import { useState, useRef, useMemo, forwardRef, memo } from 'react'
import { useCollapsibleFileList } from '@/hooks/useCollapsibleFileList'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { coy } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { FileTree, type FileTreeNode } from './FileTree'
import { FolderOpen, FileCode, AlertTriangle } from 'lucide-react'
import { cn, formatFileSize } from '@/lib/utils'
import { useResizablePanel } from '@/hooks/useResizablePanel'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import type { TruncationInfo } from '@/contexts/GeneratedFilesContext.types'
import { SHOW_MORE_INCREMENT } from '@/lib/fileListDisplay'
import { PRISM_LINE_NUMBER_STYLE } from '@/lib/prismStyles'
import { ShowMoreBanner } from '@/lib/ShowMoreBanner'
import { CollapsibleFileHeader } from '@/components/artifacts/CollapsibleFileHeader'

interface CodeFileCollectionProps {
  data: FileTreeNode[];
  className?: string;
  hideContent?: boolean;
  /** Backend truncation metadata (heavy dir recommendation) */
  truncationInfo?: TruncationInfo | null;
}

export const CodeFileCollection = ({ data, className = "", hideContent = false, truncationInfo }: CodeFileCollectionProps) => {
  const { treeWidth, isResizing, containerRef, treeRef, handleMouseDown } = useResizablePanel();
  const [focusedFileId, setFocusedFileId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Extract only file items (with content) from FileTreeNode
  const fileItems = useMemo(() => {
    const files: FileTreeNode[] = [];

    const traverse = (items: FileTreeNode[]) => {
      items.forEach(item => {
        if (item.type === 'file' && item.file) {
          files.push(item);
        }
        if (item.children) {
          traverse(item.children);
        }
      });
    };

    traverse(data);
    return files;
  }, [data]);

  // Stable identity key: detect when a *different* set of files arrives,
  // even if the count stays the same. Passed as changeKey to the hook.
  const fileIdsKey = useMemo(
    () => fileItems.map(f => f.id).join('\0'),
    [fileItems]
  );

  const {
    collapsedFiles,
    displayedItems: displayedFiles,
    hasMoreItems: hasMoreFiles,
    toggleCollapse: toggleFileCollapse,
    showMore: handleShowMore,
    expandAndJump,
    setItemRef: setFileRef,
  } = useCollapsibleFileList({
    items: fileItems,
    getKey: (f) => f.id,
    changeKey: fileIdsKey,
  });

  // CFC tree-click guard: only act on file nodes (not folders).
  const handleFileTreeClick = (item: FileTreeNode) => {
    if (item.type === 'file' && item.file) {
      setFocusedFileId(item.id);
      expandAndJump(item.id, fileItems.findIndex(f => f.id === item.id));
    }
  };

  return (
    <div className={`w-full h-full flex flex-col ${className}`}>
      {/* Content - shows empty state or file tree with files */}
      {data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-1">
          <div className="text-center">
            <FolderOpen className={`w-16 h-16 mx-auto mb-2 ${hideContent ? 'invisible' : 'text-muted-foreground'}`} />
            <h3 className={`text-lg font-medium mb-2 ${hideContent ? 'text-transparent' : 'text-muted-foreground'}`}>
              Generated files will render here.
            </h3>
            <p className={`text-sm ${hideContent ? 'text-transparent' : 'text-muted-foreground'}`}>
              Once you fill out an input form on the left, generated files will appear here.
            </p>
          </div>
        </div>
      ) : (
        <div 
          ref={containerRef}
          className={cn("flex-1 flex overflow-hidden", isResizing && "select-none")}
        >
          {/* File Tree */}
          <div 
            ref={treeRef}
            className="flex-shrink-0 overflow-y-auto"
            style={{ width: `${treeWidth}px` }}
          >
            <FileTree 
              items={data}
              onItemClick={handleFileTreeClick}
              className="relative"
            />
          </div>

          <ResizeHandle onMouseDown={handleMouseDown} />

          {/* All Files View */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto p-3"
          >
            <div className="flex flex-col gap-3">
              {/* Backend truncation banner */}
              {truncationInfo?.truncatedTree && (
                <div className="px-3 py-3 bg-warning-muted border border-warning/30 rounded-md">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-warning-foreground">
                      <p>
                        Too many files to display ({truncationInfo.totalFiles.toLocaleString()} found). Only the first {fileItems.length.toLocaleString()} files are shown.
                      </p>
                      {truncationInfo.heavyDirs && truncationInfo.heavyDirs.length > 0 && (
                        <p className="mt-1.5">
                          {truncationInfo.heavyDirs.length === 1 ? (
                            <>
                              The <code className="px-1 py-0.5 bg-warning-muted border border-warning/30 rounded text-xs font-mono">{truncationInfo.heavyDirs[0].path}/</code> directory
                              {" "}({truncationInfo.heavyDirs[0].fileCount.toLocaleString()} files) may be the cause.
                            </>
                          ) : (
                            <>
                              The following directories may be the cause:{" "}
                              {truncationInfo.heavyDirs.map((dir, i) => (
                                <span key={dir.path}>
                                  {i > 0 && ", "}
                                  <code className="px-1 py-0.5 bg-warning-muted border border-warning/30 rounded text-xs font-mono">{dir.path}/</code>
                                  {" "}({dir.fileCount.toLocaleString()} files)
                                </span>
                              ))}
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {displayedFiles.map((fileItem) => (
                <CollapsibleCodeFile
                  key={fileItem.id}
                  fileItem={fileItem}
                  isCollapsed={collapsedFiles.has(fileItem.id)}
                  isFocused={focusedFileId === fileItem.id}
                  onToggleCollapse={() => toggleFileCollapse(fileItem.id)}
                  ref={(el) => setFileRef(fileItem.id, el)}
                />
              ))}
              {/* Show more / pagination banner */}
              {hasMoreFiles && (
                <ShowMoreBanner
                  displayedCount={displayedFiles.length}
                  total={fileItems.length}
                  remaining={Math.min(SHOW_MORE_INCREMENT, fileItems.length - displayedFiles.length)}
                  noun="generated files"
                  onShowMore={handleShowMore}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Collapsible Code File Component
// ============================================================================

interface CollapsibleCodeFileProps {
  fileItem: FileTreeNode;
  isCollapsed: boolean;
  isFocused: boolean;
  onToggleCollapse: () => void;
}

const CollapsibleCodeFileImpl = forwardRef<HTMLDivElement, CollapsibleCodeFileProps>(
  ({ fileItem, isCollapsed, isFocused, onToggleCollapse }, ref) => {
    const filePath = fileItem.file?.path || fileItem.name;
    const code = fileItem.file?.content || '';
    const language = fileItem.file?.language || 'text';
    const isTruncated = fileItem.file?.isTruncated === true;
    const lineCount = code ? code.split('\n').length : 0;

    const fileSize = fileItem.file?.size ?? 0;
    const fileSizeLabel = formatFileSize(fileSize);

    return (
      <div
        ref={ref}
        data-testid={`code-file-${filePath}`}
        className={cn(
          "border border-border rounded-md overflow-hidden bg-card",
          isFocused && "ring-2 ring-ring"
        )}
      >
        {/* File Header Bar */}
        <CollapsibleFileHeader
          isCollapsed={isCollapsed}
          onToggle={onToggleCollapse}
          path={filePath}
          icon={<FileCode className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
          trailing={
            <span className="text-xs text-muted-foreground flex-shrink-0">
              {isTruncated ? fileSizeLabel : `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}
            </span>
          }
        />

        {/* File Content */}
        {!isCollapsed && (
          isTruncated ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              File too large to display inline ({fileSizeLabel}).
            </div>
          ) : (
            <SyntaxHighlighter
              language={language}
              style={coy}
              showLineNumbers={true}
              customStyle={{
                fontSize: '12px',
                margin: 0,
                borderRadius: 0,
                border: 'none',
                padding: '14px 0px',
                overflowX: 'auto'
              }}
              lineNumberStyle={PRISM_LINE_NUMBER_STYLE}
            >
              {code}
            </SyntaxHighlighter>
          )
        )}
      </div>
    );
  }
);
CollapsibleCodeFileImpl.displayName = 'CollapsibleCodeFileImpl';

/**
 * Memoize on the props that actually affect render output. We deliberately
 * skip `onToggleCollapse` (an inline closure recreated each parent render —
 * its behavior is fully captured by `isCollapsed`) and the forwarded `ref`
 * callback. Without this, every parent re-render reruns the Prism
 * SyntaxHighlighter for every visible file, which dominates paint time
 * after a Template render.
 */
const CollapsibleCodeFile = memo(CollapsibleCodeFileImpl, (prev, next) => {
  if (prev.isCollapsed !== next.isCollapsed) return false;
  if (prev.isFocused !== next.isFocused) return false;
  const a = prev.fileItem;
  const b = next.fileItem;
  if (a === b) return true;
  if (a.id !== b.id) return false;
  if (a.name !== b.name) return false;
  if (a.file?.content !== b.file?.content) return false;
  if (a.file?.path !== b.file?.path) return false;
  if (a.file?.language !== b.file?.language) return false;
  if (a.file?.size !== b.file?.size) return false;
  if (a.file?.isTruncated !== b.file?.isTruncated) return false;
  return true;
});
CollapsibleCodeFile.displayName = 'CollapsibleCodeFile';
