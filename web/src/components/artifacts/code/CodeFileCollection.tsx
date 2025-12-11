import { useState, useRef, useMemo, useEffect } from 'react'
import { FileTree, type FileTreeNode } from './FileTree'
import { CodeFile } from './CodeFile'
import { FolderOpen, ChevronLeft, Info, Copy, Check } from 'lucide-react'
import { copyTextToClipboard } from '@/lib/utils'


interface CodeFileCollectionProps {
  data: FileTreeNode[];
  className?: string;
  onHide?: () => void;
  hideContent?: boolean;
  absoluteOutputPath?: string;
  relativeOutputPath?: string;
}

export const CodeFileCollection = ({ data, className = "", onHide, hideContent = false, absoluteOutputPath, relativeOutputPath }: CodeFileCollectionProps) => {
  const [treeWidth, setTreeWidth] = useState(200);
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [isPathVisible, setIsPathVisible] = useState(false);
  const [didCopyPath, setDidCopyPath] = useState(false);
  
  // Track if the user manually selected a file (vs automatic data updates)
  const userSelectedFileRef = useRef<string | null>(null);

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

  // Effect to handle scrolling only when user explicitly clicks a file
  // We use userSelectedFileRef to distinguish user clicks from data updates
  useEffect(() => {
    // Only scroll if the user explicitly selected this file (not on data updates)
    if (!userSelectedFileRef.current) return;
    
    const fileIdToScrollTo = userSelectedFileRef.current;
    // Clear the ref so we don't scroll again on subsequent renders
    userSelectedFileRef.current = null;
    
    // Use double requestAnimationFrame to ensure both layout AND paint are complete
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const fileRef = fileRefs.current[fileIdToScrollTo];
        
        if (fileRef) {
          fileRef.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
            inline: 'nearest'
          });
        }
      });
    });
  }, [selectedFileId]);

  // Handle file tree item clicks
  const handleFileTreeClick = (item: FileTreeNode) => {
    if (item.type === 'file' && item.file) {
      // Mark this as a user-initiated selection so we scroll to it
      userSelectedFileRef.current = item.id;
      setSelectedFileId(item.id);
    }
  };

  // Handle file tree width changes
  const handleTreeWidthChange = (width: number) => {
    setTreeWidth(width);
  };

  // Reset the "copied" state after a brief delay
  useEffect(() => {
    if (!didCopyPath) return;
    const timer = window.setTimeout(() => setDidCopyPath(false), 1500);
    return () => window.clearTimeout(timer);
  }, [didCopyPath]);

  const generatedFilesAbsolutePath = absoluteOutputPath;
  const generatedFilesRelativePath = useMemo(() => {
    // This should reflect the CLI `--output-path` value (relative to where runbooks was launched),
    // NOT an inferred suffix of the absolute path (which can be any directory).
    const raw = (relativeOutputPath || '').trim()

    if (!raw) return '/generated'

    // Normalize windows separators for display
    const normalized = raw.replaceAll('\\', '/')

    // If user provided an absolute path, show it as-is.
    if (normalized.startsWith('/')) return normalized
    if (/^[a-zA-Z]:\//.test(normalized)) return normalized

    // Relative paths:
    // - "." / "./foo" should stay as-is (clearly relative)
    // - "generated" / "foo/bar" we render with a leading slash for readability in the sentence
    if (normalized === '.' || normalized.startsWith('./') || normalized.startsWith('../')) return normalized
    return `/${normalized}`
  }, [relativeOutputPath])

  const copyToClipboard = async (text: string) => {
    const ok = await copyTextToClipboard(text)
    if (ok) setDidCopyPath(true)
  }

  return (
    <div className={`w-full h-full flex flex-col ${className}`}>
      {/* Header */}
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
            className="p-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-all duration-200 cursor-pointer"
            title="Hide generated files"
          >
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </button>
        )}
      </div>

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
        <div className="flex-1 relative overflow-hidden">
          <div className="absolute inset-0 p-1">
            <FileTree 
              items={data}
              onItemClick={handleFileTreeClick}
              onWidthChange={handleTreeWidthChange}
              className="absolute"
              minWidth={150}
              maxWidth={300}
            />

            <div 
              ref={scrollContainerRef}
              className="overflow-y-auto h-full"
              style={{ marginLeft: `${treeWidth}px` }}
            >
              {fileItems.map((fileItem) => (
                <div 
                  key={fileItem.id}
                  ref={(el) => {
                    fileRefs.current[fileItem.id] = el;
                  }}
                >
                  <CodeFile
                    fileName={fileItem.file?.name || fileItem.name}
                    filePath={fileItem.file?.path || fileItem.name}
                    code={fileItem.file?.content || ''}
                    language={fileItem.file?.language || 'text'}
                    showLineNumbers={true}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
