import { useState, useEffect, useMemo, useRef } from 'react'
import { useTree } from '@headless-tree/react'
import { syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature } from '@headless-tree/core'
import { cn } from '../../lib/utils'

// Configure headless file tree styles
import '../../css/headless-tree.css'

export interface CodeFileTreeItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: CodeFileTreeItem[];
}

export interface FileTreeProps {
  items: FileTreeItem[];
  onItemClick?: (item: FileTreeItem) => void;
  onWidthChange?: (width: number) => void;
  className?: string;
  indent?: number;
  minWidth?: number;
  maxWidth?: number;
}

export const FileTree = ({ 
  items, 
  onItemClick, 
  onWidthChange,
  className = "", 
  indent = 20,
  minWidth = 150,
  maxWidth = 300
}: FileTreeProps) => {
  const [treeWidth, setTreeWidth] = useState(200);

  // Convert the items array to a flat structure for the tree
  const flatItems = useMemo(() => {
    const flatten = (items: FileTreeItem[], parentId?: string): Record<string, string[]> => {
      const result: Record<string, string[]> = {};
      
      items.forEach(item => {
        const itemId = parentId ? `${parentId}-${item.id}` : item.id;
        
        if (item.children && item.children.length > 0) {
          result[itemId] = item.children.map(child => `${itemId}-${child.id}`);
          // Recursively flatten children
          const childFlattened = flatten(item.children, itemId);
          Object.assign(result, childFlattened);
        } else {
          result[itemId] = [];
        }
      });
      
      return result;
    };

    return flatten(items);
  }, [items]);

  // Create a map of item IDs to their data
  const itemDataMap = useMemo(() => {
    const createMap = (items: FileTreeItem[], parentId?: string): Record<string, FileTreeItem> => {
      const result: Record<string, FileTreeItem> = {};
      
      items.forEach(item => {
        const itemId = parentId ? `${parentId}-${item.id}` : item.id;
        result[itemId] = item;
        
        if (item.children && item.children.length > 0) {
          const childMap = createMap(item.children, itemId);
          Object.assign(result, childMap);
        }
      });
      
      return result;
    };

    return createMap(items);
  }, [items]);

  const tree = useTree<string>({
    rootItemId: "root",
    getItemName: (item) => itemDataMap[item.getId()]?.name || '',
    isItemFolder: (item) => itemDataMap[item.getId()]?.type === 'folder',
    dataLoader: {
      getItem: (itemId) => itemId,
      getChildren: (itemId) => {
        if (itemId === "root") {
          return items.map(item => item.id);
        }
        return flatItems[itemId] || [];
      },
    },
    indent,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  // Get tree items
  const treeItems = tree.getItems();

  // Calculate the optimal width based on the longest item name
  const optimalWidth = useMemo(() => {
    if (treeItems.length === 0) return 200;

    // Find the longest item name
    const longestName = treeItems.reduce((longest, item) => {
      const name = item.getItemName();
      return name.length > longest.length ? name : longest;
    }, '');

    // Calculate width based on character count (roughly 8px per character + padding)
    const baseWidth = 40; // Base padding
    const charWidth = 8; // Approximate width per character
    const calculatedWidth = baseWidth + (longestName.length * charWidth);
    
    // Constrain between min and max widths
    return Math.max(minWidth, Math.min(maxWidth, calculatedWidth));
  }, [treeItems, minWidth, maxWidth]);

  // Update tree width when optimal width changes
  useEffect(() => {
    setTreeWidth(optimalWidth);
    if (onWidthChange) {
      onWidthChange(optimalWidth);
    }
  }, [optimalWidth, onWidthChange]);

  return (
    <div 
      {...tree.getContainerProps()} 
      className={cn("tree absolute", className)}
      style={{ width: `${treeWidth}px` }}
    >
      {tree.getItems().map((item) => {
        const handleClick = (e: React.MouseEvent) => {
          // Let the tree handle its own selection first
          const treeProps = item.getProps();
          if (treeProps.onClick) {
            treeProps.onClick(e);
          }
          
          // Then handle our custom callback
          const itemData = itemDataMap[item.getId()];
          if (itemData && onItemClick) {
            onItemClick(itemData);
          }
        };

        return (
          <button
            {...item.getProps()}
            key={item.getId()}
            style={{ paddingLeft: `${item.getItemMeta().level * indent}px` }}
            onClick={handleClick}
          >
            <div
              className={cn("treeitem", {
                focused: item.isFocused(),
                expanded: item.isExpanded(),
                selected: item.isSelected(),
                folder: item.isFolder(),
              })}
            >
              {item.getItemName()}
            </div>
          </button>
        );
      })}
    </div>
  );
};
