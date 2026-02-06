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

import { useState, useMemo, useEffect, type SVGProps } from 'react'
import { 
  Folder, 
  FolderOpen, 
  FileCode, 
  FileText, 
  FileJson, 
  FileType, 
  File,
  Image,
  Settings,
  FileTerminal,
  Lock,
  ChevronRight, 
  ChevronDown,
  type LucideIcon
} from 'lucide-react'
import { cn } from '../../../lib/utils'

// Icon component type that works with both Lucide icons and custom SVG icons
type IconComponent = LucideIcon | React.FC<SVGProps<SVGSVGElement> & { className?: string }>

/**
 * OpenTofu icon - official logo (dark alpha version)
 */
const OpenTofuIcon: React.FC<SVGProps<SVGSVGElement> & { className?: string }> = ({ className, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 32 32"
    fill="none"
    className={className}
    {...props}
  >
    {/* Top face */}
    <path fill="#160C56" fillOpacity="0.4" d="M15.75 2.08a.5.5 0 0 1 .5 0l10.84 5.97c.35.19.35.7 0 .89L16.24 14.9a.5.5 0 0 1-.49 0L4.91 8.94a.5.5 0 0 1 0-.9z"/>
    {/* Left face */}
    <path fill="#160C56" fillOpacity="0.8" d="M3.19 10.78a.5.5 0 0 1 .75-.45l10.95 6.02c.16.1.26.26.26.44v11.93a.5.5 0 0 1-.75.44L3.46 23.15a.51.51 0 0 1-.26-.44V10.78z"/>
    {/* Right face */}
    <path fill="#160C56" fillOpacity="0.6" d="M28.06 10.33a.5.5 0 0 1 .74.45V22.7a.5.5 0 0 1-.26.44L17.6 29.16a.5.5 0 0 1-.75-.44V16.79c0-.18.1-.35.26-.44z"/>
    {/* Eyes on left face */}
    <path fill="#160C56" d="M7.79 20.13v.02L5.22 18.8v-.02c.06-.8.68-1.15 1.39-.77s1.24 1.32 1.18 2.12m4.04 2.33v.02l-2.57-1.36v-.01c.06-.8.68-1.15 1.39-.77s1.24 1.32 1.18 2.12"/>
  </svg>
)

/**
 * Terragrunt icon - official logo
 */
const TerragruntIcon: React.FC<SVGProps<SVGSVGElement> & { className?: string }> = ({ className, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 525 526"
    className={className}
    {...props}
  >
    <path fillRule="evenodd" clipRule="evenodd" d="M256.867 0.513672L479.187 128.514V384.514L256.867 512.514L34.5469 384.514V128.514L256.867 0.513672ZM455.187 142.332L256.867 28.1495L58.5469 142.332V370.696L256.867 484.878L455.187 370.696V142.332Z" fill="#160C56"/>
    <path d="M356.027 427.788L455.187 370.697L356.027 313.606L256.867 370.697V484.879L356.027 427.788Z" fill="#160C56" fillOpacity="0.4"/>
    <path d="M256.867 256.515V370.697L356.027 313.606L256.867 256.515Z" fill="#160C56" fillOpacity="0.8"/>
    <path d="M356.027 199.423L256.867 256.515L356.027 313.606L455.187 256.515L356.027 199.423Z" fill="#160C56" fillOpacity="0.6"/>
    <path d="M356.027 85.2414L256.867 28.1504L157.707 85.2414L58.5469 142.332L157.707 199.423L256.867 142.332L356.027 199.423L455.187 142.332L356.027 85.2414Z" fill="#160C56" fillOpacity="0.4"/>
    <path d="M256.867 256.515L356.027 199.423L256.867 142.332L157.707 199.423L256.867 256.515Z" fill="#160C56" fillOpacity="0.8"/>
  </svg>
)

/**
 * Returns the appropriate icon component for a file based on its extension.
 */
function getFileIcon(filename: string): IconComponent {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const name = filename.toLowerCase()
  
  // Special filenames
  if (name === 'terragrunt.hcl') return TerragruntIcon
  if (name === 'dockerfile' || name === 'makefile' || name === 'taskfile.yml') return Settings
  if (name.startsWith('.env')) return Lock
  if (name === 'license' || name === 'license.md' || name === 'license.txt') return FileText
  
  // By extension
  switch (ext) {
    // Code files
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'go':
    case 'py':
    case 'rb':
    case 'rs':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'cs':
    case 'php':
    case 'swift':
    case 'kt':
    case 'scala':
    case 'vue':
    case 'svelte':
      return FileCode
    
    // Config/data files
    case 'json':
    case 'jsonc':
      return FileJson
    
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'conf':
    case 'config':
      return Settings
    
    // Markup/text
    case 'md':
    case 'mdx':
    case 'txt':
    case 'rtf':
    case 'rst':
      return FileText
    
    // Web
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return FileType
    
    // Images
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'ico':
    case 'bmp':
      return Image
    
    // Shell/scripts
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'ps1':
    case 'bat':
    case 'cmd':
      return FileTerminal
    
    // Terraform/OpenTofu/HCL
    case 'tf':
    case 'tfvars':
    case 'hcl':
    case 'tofu':
      return OpenTofuIcon
    
    // Lock files
    case 'lock':
      return Lock
    
    default:
      return File
  }
}
// Import the headless tree styles
import '../../../css/headless-tree.css'

// Import types from the types file
import type { FileTreeNode } from './FileTree.types'

// Re-export types for backwards compatibility with existing imports
export type { File, FileTreeNode } from './FileTree.types'

/**
 * Props for the FileTree component.
 * This component renders a hierarchical file tree with expand/collapse functionality.
 */
export interface FileTreeProps {
  /** Array of file/folder items to display in the tree */
  items: FileTreeNode[];
  /** Callback function called when a file/folder is clicked */
  onItemClick?: (item: FileTreeNode) => void;
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
  indent = 11, // Indent per level (8 base + 11 = 19px for level 1)
  minWidth = 150,
  maxWidth = 300
}: FileTreeProps) => {
  /** Set of expanded folder IDs */
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  /** Currently selected item ID */
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  /** Current width of the tree in pixels */
  const [_treeWidth, setTreeWidth] = useState(200);

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
    const findLongestName = (items: FileTreeNode[]): string => {
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
  const handleItemClick = (item: FileTreeNode) => {
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
   * GitHub-style layout:
   * - Folders: [padding][chevron][icon][name]
   * - Files: [padding][icon][name]  (NO chevron spacer)
   * 
   * With indent = chevron width, file icons align with parent folder icons.
   * 
   * @param item - The item to render
   * @param level - The nesting level (used for indentation)
   * @returns JSX element representing the item and its children
   */
  const renderItem = (item: FileTreeNode, level: number = 0) => {
    const isExpanded = expandedItems.has(item.id);
    const isSelected = selectedItem === item.id;
    const isFolder = item.type === 'folder';

    return (
      <div key={item.id} className="w-max min-w-full">
        <button
          role="treeitem"
          onClick={() => handleItemClick(item)}
          className="min-w-full w-max flex items-center gap-0.5 py-1 pr-2 text-left text-sm cursor-pointer text-gray-700"
          style={{ 
            paddingLeft: `${8 + level * indent}px`,
            backgroundColor: isSelected ? '#e5e7eb' : undefined,
            fontWeight: isSelected ? 500 : undefined,
          }}
          onMouseEnter={(e) => {
            if (!isSelected) e.currentTarget.style.backgroundColor = '#f3f4f6'
          }}
          onMouseLeave={(e) => {
            if (!isSelected) e.currentTarget.style.backgroundColor = ''
          }}
        >
          {isFolder ? (
            <>
              {/* Folder: chevron + icon (gray) */}
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen className="w-4 h-4 text-gray-500 flex-shrink-0" />
              ) : (
                <Folder className="w-4 h-4 text-gray-500 flex-shrink-0" />
              )}
            </>
          ) : (
            /* File: spacer (same width as chevron) + icon to align with folder icons */
            <>
              <span className="w-4 flex-shrink-0" />
              {(() => {
                const Icon = getFileIcon(item.name)
                return <Icon className="w-4 h-4 text-gray-500 flex-shrink-0" />
              })()}
            </>
          )}
          
          <span className="whitespace-nowrap ml-1">{item.name}</span>
        </button>
        
        {isFolder && isExpanded && item.children && (
          <div className="w-max min-w-full">
            {item.children.map(child => renderItem(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  // Render the tree container with items or empty state
  return (
    <div 
      className={cn("tree pt-1 pb-1 mt-[7px] w-max min-w-full", className)}
    >
      {items.length === 0 ? (
        <div className="p-4 text-gray-500 text-sm">No files to display</div>
      ) : (
        items.map(item => renderItem(item))
      )}
    </div>
  );
};
