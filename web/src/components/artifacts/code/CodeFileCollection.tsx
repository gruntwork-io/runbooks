import { useState, useRef, useMemo, useEffect } from 'react'
import { FileTree, type FileTreeNode } from './FileTree'
import { CodeFile } from './CodeFile'
import { FolderOpen, ChevronLeft } from 'lucide-react'


interface CodeFileCollectionProps {
  data: FileTreeNode[];
  className?: string;
  onHide?: () => void;
  hideContent?: boolean;
}

export const CodeFileCollection = ({ data, className = "", onHide, hideContent = false }: CodeFileCollectionProps) => {
  const [treeWidth, setTreeWidth] = useState(200);
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  
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

  return (
    <div className={`w-full h-full flex flex-col ${className}`}>
      {/* Header - shown on desktop */}
      <div className="hidden lg:flex lg:items-center lg:justify-between lg:py-2 lg:mb-3 lg:border-b lg:border-gray-200 lg:bg-transparent">
        <h2 className="text-lg font-semibold text-gray-700">Generated Files</h2>
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
