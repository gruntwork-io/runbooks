import { CodeFileCollection } from '../artifacts/code/CodeFileCollection'
import { useFileTree } from '../../hooks/useFileTree'


interface ArtifactsContainerProps {
  className?: string;
  onHide?: () => void;
  hideContent?: boolean;
  absoluteOutputPath?: string;
  relativeOutputPath?: string;
}

export const ArtifactsContainer = ({ className = "", onHide, hideContent = false, absoluteOutputPath, relativeOutputPath }: ArtifactsContainerProps) => {
  const { fileTree } = useFileTree()
  
  // Use real filetree data if available, otherwise show empty state
  const codeFileData = fileTree && fileTree.length > 0 ? fileTree : []
  
  return (
    <CodeFileCollection
      data={codeFileData}
      className={className}
      onHide={onHide}
      hideContent={hideContent}
      absoluteOutputPath={absoluteOutputPath}
      relativeOutputPath={relativeOutputPath}
    />
  )
}
