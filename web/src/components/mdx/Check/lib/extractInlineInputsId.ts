import type { ReactNode } from 'react'

/**
 * Extracts the id prop from an inline Inputs or BoilerplateInputs component.
 * 
 * This function searches through React children to find an Inputs (or legacy BoilerplateInputs) 
 * component and extracts its id prop, which is needed to look up variables from the context.
 * 
 * @param children - React children nodes that may contain an Inputs component
 * @returns The id string if found, or null if no Inputs component exists
 */
export function extractInlineInputsId(children: ReactNode): string | null {
  if (!children) return null;
  
  // Component names to look for (Inputs is the new name, BoilerplateInputs is legacy)
  const inputsComponentNames = ['Inputs', 'BoilerplateInputs'];
  
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
      
      // Check if this is an Inputs or BoilerplateInputs component
      let isInputsComponent = false;
      
      if (typeof element.type === 'object' && element.type !== null) {
        isInputsComponent = 
          inputsComponentNames.includes(element.type.displayName ?? '') || 
          inputsComponentNames.includes(element.type.name ?? '');
      } else if (typeof element.type === 'function') {
        const funcType = element.type as { name?: string; displayName?: string };
        isInputsComponent = 
          inputsComponentNames.includes(funcType.name ?? '') || 
          inputsComponentNames.includes(funcType.displayName ?? '');
      }
      
      if (isInputsComponent && element.props?.id) {
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

