import { Workspace } from '../artifacts/workspace'
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
  const generatedFiles = fileTree && fileTree.length > 0 ? fileTree : []
  
  return (
    <Workspace
      generatedFiles={generatedFiles}
      className={className}
      onHide={onHide}
      hideContent={hideContent}
      absoluteOutputPath={absoluteOutputPath}
      relativeOutputPath={relativeOutputPath}
    />
  )
}
