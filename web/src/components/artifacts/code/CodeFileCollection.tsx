import { useState, useRef, useMemo, useEffect, useCallback, forwardRef } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { coy } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { FileTree, type FileTreeNode } from './FileTree'
import { FolderOpen, ChevronLeft, ChevronDown, ChevronRight, Info, Copy, Check, FileCode } from 'lucide-react'
import { cn, copyTextToClipboard } from '@/lib/utils'


interface CodeFileCollectionProps {
  data: FileTreeNode[];
  className?: string;
  onHide?: () => void;
  hideContent?: boolean;
  absoluteOutputPath?: string;
  relativeOutputPath?: string;
  /** When true, hides the header (used when embedded in FilesWorkspace) */
  hideHeader?: boolean;
}

export const CodeFileCollection = ({ data, className = "", onHide, hideContent = false, absoluteOutputPath, relativeOutputPath, hideHeader = false }: CodeFileCollectionProps) => {
  const [treeWidth, setTreeWidth] = useState(225);
  const [isResizing, setIsResizing] = useState(false);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [focusedFileId, setFocusedFileId] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [isPathVisible, setIsPathVisible] = useState(false);
  const [didCopyPath, setDidCopyPath] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(225);
  const rafRef = useRef<number | null>(null);

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

  // Handle resize drag - update DOM directly for performance
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    widthRef.current = treeWidth;
    setIsResizing(true);
  }, [treeWidth]);
  
  useEffect(() => {
    if (!isResizing) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      
      rafRef.current = requestAnimationFrame(() => {
        if (!containerRef.current || !treeRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const newWidth = Math.min(Math.max(e.clientX - containerRect.left, 150), 400);
        treeRef.current.style.width = `${newWidth}px`;
        widthRef.current = newWidth;
      });
    };
    
    const handleMouseUp = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setTreeWidth(widthRef.current);
      setIsResizing(false);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [isResizing]);

  // Handle file tree item clicks - jump to file
  const handleFileTreeClick = (item: FileTreeNode) => {
    if (item.type === 'file' && item.file) {
      setFocusedFileId(item.id);
      // Expand the file if collapsed
      setCollapsedFiles(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      // Jump to the file (no smooth scroll)
      const fileEl = fileRefs.current.get(item.id);
      if (fileEl) {
        fileEl.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    }
  };

  // Toggle file collapse
  const toggleFileCollapse = (fileId: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  };

  // Register file ref
  const setFileRef = useCallback((fileId: string, el: HTMLDivElement | null) => {
    if (el) {
      fileRefs.current.set(fileId, el);
    } else {
      fileRefs.current.delete(fileId);
    }
  }, []);

  // Reset the "copied" state after a brief delay
  useEffect(() => {
    if (!didCopyPath) return;
    const timer = window.setTimeout(() => setDidCopyPath(false), 1500);
    return () => window.clearTimeout(timer);
  }, [didCopyPath]);

  const generatedFilesAbsolutePath = absoluteOutputPath;
  const generatedFilesRelativePath = useMemo(() => {
    const raw = (relativeOutputPath || '').trim();
    return raw.replaceAll('\\', '/');
  }, [relativeOutputPath])

  const copyToClipboard = async (text: string) => {
    const ok = await copyTextToClipboard(text)
    if (ok) setDidCopyPath(true)
  }

  return (
    <div className={`w-full h-full flex flex-col ${className}`}>
      {/* Header - only shown when not embedded in FilesWorkspace */}
      {!hideHeader && (
        <div className="flex items-start justify-between py-2 mb-3 border-b border-gray-200 bg-transparent">
          <div className="min-w-0 pl-4 lg:pl-0">
            <h2 className="text-lg font-semibold text-gray-700">Generated Files</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 italic">
              <span>
                The files below are located in <code className="px-1 py-0.5 bg-gray-50 border border-gray-200 rounded text-[11px] text-gray-500 not-italic">{generatedFilesRelativePath}</code> relative to where you ran the runbook
              </span>

              <button
                type="button"
                className={`inline-flex items-center justify-center rounded-md border border-gray-200 bg-white px-2 py-1 hover:bg-gray-50 ${
                  !generatedFilesAbsolutePath ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                }`}
                aria-label="Show generated files absolute path"
                title={generatedFilesAbsolutePath ? 'Show absolute path' : 'Absolute path unavailable'}
                disabled={!generatedFilesAbsolutePath}
                onClick={() => setIsPathVisible((prev) => !prev)}
              >
                <Info className="h-3.5 w-3.5 text-gray-600" />
              </button>

              <button
                type="button"
                className={`inline-flex items-center justify-center rounded-md border border-gray-200 bg-white px-2 py-1 hover:bg-gray-50 ${
                  !generatedFilesAbsolutePath ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                }`}
                aria-label="Copy generated files absolute path"
                title={generatedFilesAbsolutePath ? 'Copy absolute path' : 'Absolute path unavailable'}
                disabled={!generatedFilesAbsolutePath}
                onClick={() => {
                  if (!generatedFilesAbsolutePath) return;
                  void copyToClipboard(generatedFilesAbsolutePath);
                }}
              >
                {didCopyPath ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-gray-600" />
                )}
              </button>
            </div>

            {isPathVisible && generatedFilesAbsolutePath && (
              <div className="mt-1 mb-1 text-xs text-gray-600">
                <span className="mr-1 text-gray-500 italic">Absolute path:</span>
                <code className="break-all rounded bg-gray-50 px-1 py-0.5 text-[11px] text-gray-500 border border-gray-200">
                  {generatedFilesAbsolutePath}
                </code>
              </div>
            )}
          </div>

          {onHide && (
            <button
              onClick={onHide}
              className="hidden lg:block p-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-all duration-200 cursor-pointer"
              title="Hide generated files"
            >
              <ChevronLeft className="w-5 h-5 text-gray-600" />
            </button>
          )}
        </div>
      )}

      {/* Content - shows empty state or file tree with files */}
      {data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-1">
          <div className="text-center">
            <FolderOpen className={`w-16 h-16 mx-auto mb-2 ${hideContent ? 'invisible' : 'text-gray-300'}`} />
            <h3 className={`text-lg font-medium mb-2 ${hideContent ? 'text-transparent' : 'text-gray-600'}`}>
              Generated files will render here.
            </h3>
            <p className={`text-sm ${hideContent ? 'text-transparent' : 'text-gray-500'}`}>
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

          {/* Resize Handle - 7px hit area with 1px visible line */}
          <div
            className="w-[7px] cursor-col-resize flex-shrink-0 flex items-stretch justify-center group"
            onMouseDown={handleMouseDown}
          >
            <div className="w-px bg-gray-300 group-hover:bg-blue-500 group-hover:shadow-[0_0_0_2px_rgba(59,130,246,0.5)] transition-all" />
          </div>

          {/* All Files View */}
          <div 
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto p-3"
          >
            <div className="flex flex-col gap-3">
              {fileItems.map((fileItem) => (
                <CollapsibleCodeFile
                  key={fileItem.id}
                  fileItem={fileItem}
                  isCollapsed={collapsedFiles.has(fileItem.id)}
                  isFocused={focusedFileId === fileItem.id}
                  onToggleCollapse={() => toggleFileCollapse(fileItem.id)}
                  ref={(el) => setFileRef(fileItem.id, el)}
                />
              ))}
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

const CollapsibleCodeFile = forwardRef<HTMLDivElement, CollapsibleCodeFileProps>(
  ({ fileItem, isCollapsed, isFocused, onToggleCollapse }, ref) => {
    const [didCopy, setDidCopy] = useState(false);
    
    const filePath = fileItem.file?.path || fileItem.name;
    const code = fileItem.file?.content || '';
    const language = fileItem.file?.language || 'text';
    const lineCount = code.split('\n').length;
    
    const handleCopyPath = () => {
      setDidCopy(true);
      copyTextToClipboard(filePath);
      setTimeout(() => setDidCopy(false), 1500);
    };
    
    return (
      <div 
        ref={ref}
        className={cn(
          "border border-gray-300 rounded-md overflow-hidden bg-white",
          isFocused && "ring-2 ring-blue-500"
        )}
      >
        {/* File Header Bar */}
        <div
          onClick={onToggleCollapse}
          className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 text-left cursor-pointer border-b border-gray-200"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleCollapse() }}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
          )}
          <FileCode className="w-4 h-4 text-gray-500 flex-shrink-0" />
          <span className="font-mono text-xs text-gray-700 truncate">
            {filePath}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); handleCopyPath() }}
            className="p-0.5 text-gray-400 hover:text-gray-600 rounded flex-shrink-0"
            title="Copy file path"
          >
            {didCopy ? (
              <Check className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <div className="flex-1" />
          <span className="text-xs text-gray-500 flex-shrink-0">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        </div>
        
        {/* File Content */}
        {!isCollapsed && (
          <SyntaxHighlighter 
            language={language}
            style={coy}
            showLineNumbers={true}
            customStyle={{
              fontSize: '12px',
              margin: 0,
              borderRadius: 0,
              border: 'none',
              padding: '14px 0px'
            }}
            lineNumberStyle={{
              color: '#999',
              fontSize: '11px',
              paddingRight: '12px',
              borderRight: '1px solid #eee',
              marginRight: '8px'
            }}
          >
            {code}
          </SyntaxHighlighter>
        )}
      </div>
    );
  }
);
CollapsibleCodeFile.displayName = 'CollapsibleCodeFile';
