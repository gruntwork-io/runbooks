import { useState, useRef, useMemo } from 'react'
import { FileTree, type FileTreeNode } from './FileTree'
import { CodeFile } from './CodeFile'
import { FolderOpen } from 'lucide-react'


interface CodeFileCollectionProps {
  data: FileTreeNode[];
  className?: string;
}

export const CodeFileCollection = ({ data, className = "" }: CodeFileCollectionProps) => {
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

  // Show empty state if no files
  if (data.length === 0) {
    return (
      <div className={`p-1 w-full min-h-[200px] flex items-center justify-center ${className}`}>
        <div className="text-center">
          <FolderOpen className="w-16 h-16 mx-auto mb-2 text-gray-300" />
          <h3 className="text-lg font-medium text-gray-600 mb-2">Generated files will render here.</h3>
          <p className="text-sm text-gray-500">Once you fill out an input form on the left, generated files will appear here.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`p-1 w-full min-h-[200px] ${className}`}>
      <FileTree 
        items={data}
        onItemClick={handleFileTreeClick}
        onWidthChange={handleTreeWidthChange}
        className="absolute"
        minWidth={150}
        maxWidth={300}
      />

      <div style={{ marginLeft: `${treeWidth}px` }}>
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
  )
}
