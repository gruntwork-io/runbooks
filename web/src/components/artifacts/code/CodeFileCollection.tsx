import { useState, useRef, useMemo } from 'react'
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

  // Handle file tree item clicks
  const handleFileTreeClick = (item: FileTreeNode) => {
    if (item.type === 'file' && item.file) {
      scrollToFile(item.id);
    }
  };

  // Handle file tree width changes
  const handleTreeWidthChange = (width: number) => {
    setTreeWidth(width);
  };

  // Handle scrolling to specific file
  const scrollToFile = (fileId: string) => {
    const fileRef = fileRefs.current[fileId];
    if (fileRef) {
      const elementTop = fileRef.offsetTop;
      const scrollContainer = fileRef.closest('.overflow-y-auto');
      if (scrollContainer) {
        scrollContainer.scrollTo({
          top: elementTop - 52, // 52px above the file header to ensure it's visible
          behavior: 'smooth'
        });
      }
    }
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
