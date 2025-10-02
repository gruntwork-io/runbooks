import type { ReactNode } from 'react'

/**
 * Extracts the id prop from an inline BoilerplateInputs component.
 * 
 * This function searches through React children to find a BoilerplateInputs component
 * and extracts its id prop, which is needed to look up variables from the context.
 * 
 * @param children - React children nodes that may contain a BoilerplateInputs component
 * @returns The id string if found, or null if no BoilerplateInputs component exists
 */
export function extractInlineInputsId(children: ReactNode): string | null {
  if (!children) return null;
  
  const extractFromNode = (node: ReactNode): string | null => {
    if (!node) return null;
    
    if (Array.isArray(node)) {
      for (const child of node) {
        const result = extractFromNode(child);
        if (result) return result;
      }
      return null;
    }
    
    if (typeof node === 'object' && 'type' in node) {
      const element = node as { 
        type?: { displayName?: string; name?: string } | string | ((...args: unknown[]) => unknown);
        props?: { 
          id?: string;
          children?: ReactNode;
        } 
      };
      
      // Check if this is a BoilerplateInputs component
      let isBoilerplateInputs = false;
      
      if (typeof element.type === 'object' && element.type !== null) {
        isBoilerplateInputs = 
          element.type.displayName === 'BoilerplateInputs' || 
          element.type.name === 'BoilerplateInputs';
      } else if (typeof element.type === 'function') {
        const funcType = element.type as { name?: string; displayName?: string };
        isBoilerplateInputs = 
          funcType.name === 'BoilerplateInputs' || 
          funcType.displayName === 'BoilerplateInputs';
      }
      
      if (isBoilerplateInputs && element.props?.id) {
        return element.props.id;
      }
      
      // Continue searching in children
      if (element.props?.children) {
        return extractFromNode(element.props.children);
      }
    }
    
    return null;
  };
  
  return extractFromNode(children);
}

