import type { ReactNode } from 'react'

/**
 * Extracts variable names from a boilerplate template by finding {{ .VariableName }} patterns.
 * 
 * Supports various template syntax variations:
 * - {{.VariableName}} (no spaces)
 * - {{ .VariableName }} (with spaces)
 * - {{ .VariableName | UpperCase }} (with pipe functions)
 * 
 * @param children - React children nodes containing the template content
 * @returns Array of unique variable names found in the template
 */
export function extractTemplateVariables(children: ReactNode): string[] {
  const variables = new Set<string>();
  
  const extractFromString = (text: string) => {
    // Match {{ .VariableName }} or {{.VariableName}} patterns
    // Also handles pipe functions like {{ .VariableName | UpperCase }}
    const regex = /\{\{\s*\.(\w+)(?:\s*\|[^}]*)?\s*\}\}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      variables.add(match[1]);
    }
  };
  
  const traverse = (node: ReactNode): void => {
    if (typeof node === 'string') {
      extractFromString(node);
    } else if (Array.isArray(node)) {
      node.forEach(traverse);
    } else if (node && typeof node === 'object' && 'props' in node) {
      const element = node as { props?: { children?: ReactNode; value?: string } };
      if (element.props?.value) {
        extractFromString(element.props.value);
      }
      if (element.props?.children) {
        traverse(element.props.children);
      }
    }
  };
  
  traverse(children);
  return Array.from(variables);
}

