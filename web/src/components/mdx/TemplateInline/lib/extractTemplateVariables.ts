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
    // Iterate over each {{ ... }} template block, then scan for dot-prefixed
    // identifiers within. This catches variables in all positions: direct access
    // ({{ .Var }}), conditionals ({{ if .Var }}), comparisons ({{ if eq .Var "x" }}),
    // and range/with blocks ({{ range $k, $v := .Var }}).
    // Only matches .Name preceded by whitespace or := (not $var.field).
    const blockRegex = /\{\{-?([\s\S]*?)-?\}\}/g;
    const varRegex = /(?:^|\s|:=)\.(\w+)/g;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(text)) !== null) {
      const blockContent = blockMatch[1];
      let varMatch;
      while ((varMatch = varRegex.exec(blockContent)) !== null) {
        variables.add(varMatch[1]);
      }
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


