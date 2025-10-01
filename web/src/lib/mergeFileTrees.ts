import type { CodeFileData } from '@/components/artifacts/code/FileTree';

/**
 * Merges two file trees, combining their contents intelligently.
 * 
 * Strategy:
 * - Files with the same path are replaced (new takes precedence)
 * - Folders with the same path are recursively merged
 * - New files/folders are added
 * 
 * @param existing - The existing file tree (can be null)
 * @param incoming - The new file tree to merge in
 * @returns The merged file tree
 */
export function mergeFileTrees(
  existing: CodeFileData[] | null,
  incoming: CodeFileData[]
): CodeFileData[] {
  // If no existing tree, just return the incoming one
  if (!existing || existing.length === 0) {
    return incoming;
  }
  
  // If no incoming tree, return the existing one
  if (!incoming || incoming.length === 0) {
    return existing;
  }
  
  // Create a map of existing items by their path for efficient lookup
  const existingMap = new Map<string, CodeFileData>();
  const buildMap = (items: CodeFileData[], parentPath: string = '') => {
    items.forEach(item => {
      const itemPath = parentPath ? `${parentPath}/${item.name}` : item.name;
      existingMap.set(itemPath, item);
      
      if (item.type === 'folder' && item.children) {
        buildMap(item.children, itemPath);
      }
    });
  };
  buildMap(existing);
  
  // Merge incoming items into existing
  const result: CodeFileData[] = [...existing];
  
  const mergeIntoLevel = (
    targetLevel: CodeFileData[], 
    incomingLevel: CodeFileData[],
    parentPath: string = ''
  ) => {
    incomingLevel.forEach(incomingItem => {
      const itemPath = parentPath ? `${parentPath}/${incomingItem.name}` : incomingItem.name;
      const existingIndex = targetLevel.findIndex(item => item.name === incomingItem.name);
      
      if (existingIndex >= 0) {
        const existingItem = targetLevel[existingIndex];
        
        // If both are folders, merge their children
        if (existingItem.type === 'folder' && incomingItem.type === 'folder') {
          const mergedChildren = existingItem.children ? [...existingItem.children] : [];
          if (incomingItem.children) {
            mergeIntoLevel(mergedChildren, incomingItem.children, itemPath);
          }
          targetLevel[existingIndex] = {
            ...existingItem,
            children: mergedChildren
          };
        } else {
          // Replace file with new version (or if type changed)
          targetLevel[existingIndex] = incomingItem;
        }
      } else {
        // New item, add it
        targetLevel.push(incomingItem);
      }
    });
  };
  
  mergeIntoLevel(result, incoming);
  
  return result;
}

