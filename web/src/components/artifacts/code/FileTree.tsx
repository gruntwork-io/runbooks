/**
 * @fileoverview FileTree Component
 * 
 * A lightweight, custom file tree component that renders hierarchical file/folder structures.
 * This component was created as a reliable alternative to the @headless-tree/react library
 * to ensure consistent rendering with the API data structure.
 * 
 * Features:
 * - Expand/collapse functionality for folders
 * - File/folder selection
 * - Automatic width calculation based on content
 * - Custom styling using headless-tree.css
 * - No external dependencies (pure React implementation)
 */

import { useState, useMemo, useEffect } from 'react'
import { cn } from '../../../lib/utils'
// Import the headless tree styles
import '../../../css/headless-tree.css'

/**
 * Represents a file or folder in the file tree structure.
 * This interface defines the hierarchical data structure used by FileTree.
 */
export interface CodeFileData {
  /** Unique identifier for the file/folder */
  id: string;
  /** Display name of the file/folder */
  name: string;
  /** Type of the item - either 'file' or 'folder' */
  type: 'file' | 'folder';
  /** Child items (only present for folders) */
  children?: CodeFileData[];
  /** File-specific properties (only present for files) */
  filePath?: string;
  /** File content (only present for files) */
  code?: string;
  /** Programming language for syntax highlighting (only present for files) */
  language?: string;
  /** File size in bytes (only present for files) */
  size?: number;
}

/**
 * Props for the FileTree component.
 * This component renders a hierarchical file tree with expand/collapse functionality.
 */
export interface FileTreeProps {
  /** Array of file/folder items to display in the tree */
  items: CodeFileData[];
  /** Callback function called when a file/folder is clicked */
  onItemClick?: (item: CodeFileData) => void;
  /** Callback function called when the tree width changes */
  onWidthChange?: (width: number) => void;
  /** Additional CSS classes to apply to the tree container */
  className?: string;
  /** Indentation in pixels for each level of nesting (default: 20) */
  indent?: number;
  /** Minimum width of the tree in pixels (default: 150) */
  minWidth?: number;
  /** Maximum width of the tree in pixels (default: 300) */
  maxWidth?: number;
}

/**
 * Renders a hierarchical file tree with expand/collapse functionality.
 * 
 * @param props - The component props
 * @returns JSX element representing the file tree
 * 
 * @example
 * ```tsx
 * const fileData = [
 *   { id: '1', name: 'src', type: 'folder', children: [
 *     { id: '2', name: 'index.ts', type: 'file', filePath: 'src/index.ts' }
 *   ]}
 * ];
 * 
 * <FileTree 
 *   items={fileData}
 *   onItemClick={(item) => console.log('Clicked:', item.name)}
 *   onWidthChange={(width) => console.log('Width:', width)}
 * />
 * ```
 */
export const FileTree = ({ 
  items, 
  onItemClick, 
  onWidthChange,
  className = "", 
  indent = 20,
  minWidth = 150,
  maxWidth = 300
}: FileTreeProps) => {
  /** Set of expanded folder IDs */
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  /** Currently selected item ID */
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  /** Current width of the tree in pixels */
  const [treeWidth, setTreeWidth] = useState(200);

  /**
   * Calculates the optimal width for the tree based on the longest item name.
   * Recursively searches through all items (including nested children) to find
   * the longest name and calculates width accordingly.
   * 
   * @returns The calculated optimal width in pixels, constrained between minWidth and maxWidth
   */
  const optimalWidth = useMemo(() => {
    if (items.length === 0) return 200;

    /**
     * Recursively finds the longest item name in the tree structure.
     * 
     * @param items - Array of items to search through
     * @returns The longest item name found
     */
    const findLongestName = (items: CodeFileData[]): string => {
      let longest = '';
      items.forEach(item => {
        if (item.name.length > longest.length) {
          longest = item.name;
        }
        if (item.children) {
          const childLongest = findLongestName(item.children);
          if (childLongest.length > longest.length) {
            longest = childLongest;
          }
        }
      });
      return longest;
    };

    const longestName = findLongestName(items);
    
    // Calculate width based on character count (roughly 8px per character + padding)
    const baseWidth = 40; // Base padding
    const charWidth = 8; // Approximate width per character
    const calculatedWidth = baseWidth + (longestName.length * charWidth);
    
    // Constrain between min and max widths
    return Math.max(minWidth, Math.min(maxWidth, calculatedWidth));
  }, [items, minWidth, maxWidth]);

  /**
   * Updates the tree width when the optimal width changes and notifies parent component.
   */
  useEffect(() => {
    setTreeWidth(optimalWidth);
    if (onWidthChange) {
      onWidthChange(optimalWidth);
    }
  }, [optimalWidth, onWidthChange]);

  /**
   * Toggles the expanded state of a folder item.
   * 
   * @param itemId - The ID of the folder to toggle
   */
  const toggleExpanded = (itemId: string) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  };

  /**
   * Handles click events on tree items.
   * Sets the selected item, toggles folder expansion, and calls the onItemClick callback.
   * 
   * @param item - The clicked item
   */
  const handleItemClick = (item: CodeFileData) => {
    setSelectedItem(item.id);
    if (item.type === 'folder') {
      toggleExpanded(item.id);
    }
    if (onItemClick) {
      onItemClick(item);
    }
  };

  /**
   * Recursively renders a tree item and its children.
   * 
   * @param item - The item to render
   * @param level - The nesting level (used for indentation)
   * @returns JSX element representing the item and its children
   */
  const renderItem = (item: CodeFileData, level: number = 0) => {
    const isExpanded = expandedItems.has(item.id);
    const isSelected = selectedItem === item.id;
    const isFolder = item.type === 'folder';

    return (
      <div key={item.id}>
        <button
          role="treeitem"
          onClick={() => handleItemClick(item)}
          className="w-full"
          style={{ paddingLeft: `${level * indent}px` }}
        >
          <div
            className={cn("treeitem", {
              selected: isSelected,
              folder: isFolder,
              expanded: isFolder && isExpanded,
            })}
          >
            {item.name}
          </div>
        </button>
        
        {isFolder && isExpanded && item.children && (
          <div>
            {item.children.map(child => renderItem(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  // Render the tree container with items or empty state
  return (
    <div 
      className={cn("tree absolute", className)}
      style={{ width: `${treeWidth}px` }}
    >
      {items.length === 0 ? (
        <div className="p-4 text-gray-500 text-sm">No files to display</div>
      ) : (
        items.map(item => renderItem(item))
      )}
    </div>
  );
};
