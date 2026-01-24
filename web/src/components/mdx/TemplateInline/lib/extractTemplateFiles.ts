import type { ReactNode } from 'react'

/**
 * Extracts template files from React children nodes.
 * 
 * For MDX code blocks, this will extract the code content and create template files.
 * 
 * @param children - React children nodes containing code blocks
 * @param outputPath - Optional output path for the template file
 * @returns Map of file paths to their contents
 */
export function extractTemplateFiles(
  children: ReactNode,
  outputPath?: string
): Record<string, string> {
  const files: Record<string, string> = {};
  
  // Extract template content from code blocks
  const extractFromNode = (node: ReactNode): void => {
    if (!node) return;
    
    if (Array.isArray(node)) {
      node.forEach(extractFromNode);
      return;
    }
    
    if (typeof node === 'object' && 'props' in node) {
      const element = node as { 
        type?: string | { displayName?: string; name?: string } | ((...args: unknown[]) => unknown);
        props?: { 
          children?: ReactNode; 
          className?: string;
          [key: string]: unknown;
        } 
      };
      
      // Check if this is a code block (pre > code structure from MDX)
      // MDX can use either native 'pre' elements or custom CodeBlock components
      let isPreElement = false;
      if (typeof element.type === 'string' && element.type === 'pre') {
        isPreElement = true;
      } else if (typeof element.type === 'function') {
        const funcType = element.type as { name?: string; displayName?: string };
        isPreElement = funcType.name === 'CodeBlock' || funcType.displayName === 'CodeBlock';
      } else if (typeof element.type === 'object' && element.type !== null) {
        isPreElement = element.type.name === 'CodeBlock' || element.type.displayName === 'CodeBlock';
      }
      
      const codeChild = isPreElement && element.props?.children;
      
      if (codeChild && typeof codeChild === 'object' && 'props' in codeChild) {
        const codeElement = codeChild as { props?: { children?: ReactNode; className?: string } };
        const content = extractTextContent(codeElement.props?.children);
        
        if (content) {
          // Use the outputPath if provided, otherwise use a simple default name
          const filename = outputPath || 'template.txt';
          files[filename] = content;
        }
      }
      
      // Continue traversing
      if (element.props?.children && !isPreElement) {
        extractFromNode(element.props.children);
      }
    }
  };
  
  extractFromNode(children);
  return files;
}

/**
 * Extracts plain text content from React nodes
 */
function extractTextContent(node: ReactNode): string {
  if (typeof node === 'string') {
    return node;
  }
  
  if (Array.isArray(node)) {
    return node.map(extractTextContent).join('');
  }
  
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as { props?: { children?: ReactNode; value?: string } };
    if (element.props?.value) {
      return element.props.value;
    }
    if (element.props?.children) {
      return extractTextContent(element.props.children);
    }
  }
  
  return '';
}


