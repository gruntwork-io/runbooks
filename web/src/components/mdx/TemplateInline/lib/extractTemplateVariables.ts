import type { ReactNode } from 'react'

/**
 * Extracts root variable names from a boilerplate template by finding {{ .VariableName }} patterns.
 *
 * Supports various template syntax variations:
 * - {{.VariableName}} (no spaces)
 * - {{ .VariableName }} (with spaces)
 * - {{ .VariableName | UpperCase }} (with pipe functions)
 * - {{ ._module.source }} (dotted paths — extracts root name "_module")
 * - {{- range $name, $val := ._module.inputs }} (range/assignment patterns)
 *
 * For dotted paths like `._module.source`, only the root name (`_module`) is extracted,
 * since that's the top-level key in the input values map.
 *
 * @param children - React children nodes containing the template content
 * @returns Array of unique root variable names found in the template
 */
export function extractTemplateVariables(children: ReactNode): string[] {
  const variables = new Set<string>();

  const extractFromString = (text: string) => {
    // Match {{ .VariableName }} or {{ .VariableName.nested.path }} patterns
    // Also handles pipe functions like {{ .VariableName | UpperCase }}
    // Captures only the root name (first segment before any dot)
    const directRegex = /\{\{-?\s*\.(\w+)(?:\.\w+)*(?:\s*\|[^}]*)?\s*-?\}\}/g;
    let match;
    while ((match = directRegex.exec(text)) !== null) {
      variables.add(match[1]);
    }

    // Match range/with/assignment patterns: {{ range $k, $v := .VarName.sub }}
    // These use := to assign from a dotted path
    const assignRegex = /\{\{-?\s*(?:range|with)\s+[^:]*:=\s*\.(\w+)(?:\.\w+)*\s*-?\}\}/g;
    while ((match = assignRegex.exec(text)) !== null) {
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


