import { Workspace } from "../artifacts/workspace"
import { useGeneratedFiles } from "../../hooks/useGeneratedFiles"

interface ArtifactsContainerProps {
  className?: string | undefined
  onHide?: (() => void) | undefined
  hideContent?: boolean | undefined
  absoluteOutputPath?: string | undefined
  relativeOutputPath?: string | undefined
}

export const ArtifactsContainer = ({
  className = "",
  onHide,
  hideContent = false,
  absoluteOutputPath,
  relativeOutputPath,
}: ArtifactsContainerProps) => {
  const { fileTree, truncationInfo } = useGeneratedFiles()

  // Use real filetree data if available, otherwise show empty state
  const generatedFiles = fileTree && fileTree.length > 0 ? fileTree : []

  return (
    <Workspace
      generatedFiles={generatedFiles}
      truncationInfo={truncationInfo}
      className={className}
      onHide={onHide}
      hideContent={hideContent}
      absoluteOutputPath={absoluteOutputPath}
      relativeOutputPath={relativeOutputPath}
    />
  )
}
