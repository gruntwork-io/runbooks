import { CodeFileCollection } from './artifacts/code/CodeFileCollection'
import { useFileTree } from '../hooks/useFileTree'


interface ArtifactsContainerProps {
  className?: string;
}

export const ArtifactsContainer = ({ className = "" }: ArtifactsContainerProps) => {
  const { fileTree } = useFileTree()
  
  // Use real filetree data if available, otherwise show empty state
  const codeFileData = fileTree && fileTree.length > 0 ? fileTree : []
  
  return (
    <CodeFileCollection data={codeFileData} />
  )
}
