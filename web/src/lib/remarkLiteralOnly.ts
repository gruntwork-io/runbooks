import type { Node as EstreeNode, Program } from 'estree'

// Minimal shape of the MDX mdast nodes this plugin inspects (see
// mdast-util-mdxjs-esm, mdast-util-mdx-expression and mdast-util-mdx-jsx).
interface MdxNode {
  type: string
  // JSX element / attribute name (null for fragments)
  name?: string | null
  // Source text for ESM and expressions; string, null or a value expression for attributes
  value?: string | null | MdxNode
  attributes?: MdxNode[]
  data?: { estree?: Program | null }
  children?: MdxNode[]
  position?: { start: { line: number } }
}

const LITERALS_HINT =
  'Only literal values are allowed: strings, numbers, booleans, null, template strings without ${...}, and arrays or objects of those.'

/**
 * Remark plugin that keeps runbook MDX declarative.
 *
 * MDX compiles to JavaScript that the renderer evaluates with the full
 * `window.api` IPC surface in reach. Left unchecked, a runbook could run code
 * the moment it is opened, before the user has read it or clicked anything:
 * `export const _ = window.api.invoke('exec:run', ...)`, `{fetch(...)}`,
 * `command={run()}` and so on.
 *
 * This plugin rejects every construct that evaluates JavaScript:
 * - `import` / `export` statements (`mdxjsEsm`);
 * - spread props such as `<Command {...props} />` (`mdxJsxExpressionAttribute`);
 * - `{...}` in text or between blocks, unless it is empty, a comment, or a
 *   literal value;
 * - `prop={...}` values that are not literal values;
 * - `<script>` elements, because React 19 loads `<script async src>` wherever
 *   it is rendered.
 *
 * A literal value is a string, number, boolean, null or regex literal; a
 * template string without `${...}`; a number with a leading `-` or `+`; or an
 * array or object made only of literal values. That covers every documented
 * block prop, e.g. `detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']}`.
 */
export function remarkLiteralOnly() {
  return (tree: MdxNode) => {
    const visit = (node: MdxNode) => {
      switch (node.type) {
        case 'mdxjsEsm':
          throw notAllowed(node, `\`import\` and \`export\` statements are not allowed in runbooks. Remove "${excerpt(node.value)}".`)

        case 'mdxFlowExpression':
        case 'mdxTextExpression':
          if (!isLiteralProgram(node.data?.estree)) {
            throw notAllowed(node, `the expression {${excerpt(node.value)}} is not allowed in runbooks. ${LITERALS_HINT}`)
          }
          break

        case 'mdxJsxFlowElement':
        case 'mdxJsxTextElement':
          checkElement(node)
          break
      }

      node.children?.forEach(visit)
    }

    visit(tree)
  }
}

function checkElement(element: MdxNode) {
  const tag = `<${element.name ?? ''}>`

  if (element.name === 'script') {
    throw notAllowed(element, `${tag} elements are not allowed in runbooks.`)
  }

  for (const attribute of element.attributes ?? []) {
    if (attribute.type === 'mdxJsxExpressionAttribute') {
      throw notAllowed(
        attribute,
        `spread props like {${excerpt(attribute.value)}} on ${tag} are not allowed in runbooks. Pass each prop separately. ${LITERALS_HINT}`,
      )
    }

    // `prop="text"` and bare `prop` are plain strings/booleans; only
    // `prop={...}` carries an expression.
    const value = attribute.value
    if (typeof value === 'object' && value !== null && !isLiteralProgram(value.data?.estree)) {
      throw notAllowed(
        attribute,
        `the \`${attribute.name}\` prop of ${tag} must be a literal value, not {${excerpt(value.value)}}. ${LITERALS_HINT}`,
      )
    }
  }
}

// An expression's program is literal-only when it is empty (`{}` or
// `{/* comment */}`) or a single expression statement whose expression is a
// literal value. A missing program (no estree) fails closed.
function isLiteralProgram(program: Program | null | undefined): boolean {
  if (!program) return false
  if (program.body.length === 0) return true
  if (program.body.length !== 1) return false
  const [statement] = program.body
  return statement.type === 'ExpressionStatement' && isLiteralValue(statement.expression)
}

function isLiteralValue(node: EstreeNode | null): boolean {
  if (!node) return false // array hole: `[1, , 2]`
  switch (node.type) {
    case 'Literal':
      return true
    case 'TemplateLiteral':
      return node.expressions.length === 0
    case 'UnaryExpression':
      return (
        (node.operator === '-' || node.operator === '+') &&
        node.argument.type === 'Literal' &&
        typeof node.argument.value === 'number'
      )
    case 'ArrayExpression':
      return node.elements.every(isLiteralValue)
    case 'ObjectExpression':
      return node.properties.every(
        (property) =>
          property.type === 'Property' &&
          property.kind === 'init' &&
          !property.computed &&
          !property.method &&
          isLiteralValue(property.value),
      )
    default:
      return false
  }
}

function notAllowed(node: MdxNode, reason: string): Error {
  const line = node.position?.start.line
  return new Error(line ? `Line ${line}: ${reason}` : reason)
}

// A short, single-line excerpt of the offending source for error messages.
function excerpt(source: MdxNode['value']): string {
  const text = typeof source === 'string' ? source.replace(/\s+/g, ' ').trim() : ''
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}
