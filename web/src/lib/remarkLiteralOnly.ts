import type { Node as EstreeNode, Program } from "estree"

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
  "Only literal values are allowed: strings, numbers, booleans, null, template strings without ${...}, and arrays or objects of those."

/**
 * Remark plugin that keeps runbook MDX declarative.
 *
 * MDX compiles to JavaScript that the renderer evaluates with the full
 * `window.api` IPC surface in reach. Left unchecked, a runbook could run code
 * the moment it is opened, before the user has read it or clicked anything:
 * `export const _ = window.api.invoke('exec:run', ...)`, `{fetch(...)}`,
 * `command={run()}` and so on.
 *
 * This plugin rejects every construct that runs JavaScript or hands the browser
 * raw HTML or another document to load. It does not rely on the CSP, which dev
 * builds don't set:
 * - `import` / `export` statements (`mdxjsEsm`);
 * - spread props such as `<Command {...props} />` (`mdxJsxExpressionAttribute`);
 * - `{...}` in text or between blocks, unless it is empty, a comment, or a
 *   literal value;
 * - `prop={...}` values that are not literal values;
 * - elements that load scripts or embed documents (see BLOCKED_ELEMENTS);
 * - custom elements (`<x-widget>`), because React passes their props through
 *   as DOM attributes, so `ONANIMATIONSTART="..."` becomes an inline handler;
 * - dotted element names, which reach properties of a block instead of the
 *   block itself (`<Admonition.constructor>` renders `Function`);
 * - namespaced element names, because `<svg><svg:script>` creates a real
 *   script element that slips past a check on the name `script`;
 * - props and object keys that inject raw HTML or replace a prototype (see
 *   BLOCKED_PROPS);
 * - `javascript:` URLs in any prop, because React only neutralizes them in
 *   props spelled exactly `href`, `src`, `action`, `formAction` or
 *   `xlinkHref`: `<a HREF="javascript:...">`, `<button formaction=...>` and
 *   `<animate attributeName="href" values=...>` reach the DOM as written.
 *
 * A literal value is a string, number, boolean, null or regex literal; a
 * template string without `${...}`; a number with a leading `-` or `+`; or an
 * array or object made only of literal values. That covers every documented
 * block prop, e.g. `detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']}`.
 *
 * The ESM and expression checks are an allowlist and fail closed: anything
 * not known to be a literal is rejected. The element and prop checks are a
 * denylist of the known routes from literal markup to script, so an element or
 * prop that is not listed is allowed. They are defense in depth on top of the
 * renderer's sandbox, context isolation, production CSP and will-navigate
 * guard, not a complete HTML sanitizer.
 */
export function remarkLiteralOnly() {
  return (tree: MdxNode) => {
    const visit = (node: MdxNode) => {
      switch (node.type) {
        case "mdxjsEsm":
          throw notAllowed(
            node,
            `\`import\` and \`export\` statements are not allowed in runbooks. Remove "${excerpt(node.value)}".`,
          )

        case "mdxFlowExpression":
        case "mdxTextExpression":
          if (!isLiteralProgram(node.data?.estree)) {
            throw notAllowed(
              node,
              `the expression {${excerpt(node.value)}} is not allowed in runbooks. ${LITERALS_HINT}`,
            )
          }
          break

        case "mdxJsxFlowElement":
        case "mdxJsxTextElement":
          checkElement(node)
          break
      }

      node.children?.forEach(visit)
    }

    visit(tree)
  }
}

// Elements that load and run scripts or embed other documents. React 19 loads
// `<script async src>` wherever it is rendered, and a frame's document (e.g.
// `<iframe srcDoc>`) shares the app's origin and CSP, so it could rebuild the
// same script load and reach `parent.api`. A `<webview>` would embed a page
// without the Iframe block's Load button. Compared lowercased.
const BLOCKED_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "webview",
])

// Prop names (compared lowercased) that are never literal content:
// `dangerouslySetInnerHTML` and `srcDoc` inject raw HTML, whose inline event
// handlers (`<img onerror>`) run as soon as it is parsed; `__proto__` replaces
// the prototype of the props (or object) it appears in.
const BLOCKED_PROPS = new Set(["dangerouslysetinnerhtml", "srcdoc", "__proto__"])

// A `javascript:` URL as browsers parse one: leading control characters and
// spaces are skipped, and tabs and newlines inside the scheme are ignored.
// This is the test React applies to the props it sanitizes; a click on any
// other element or prop holding such a URL runs it with `window.api` in reach.
const JAVASCRIPT_URL =
  // eslint-disable-next-line no-control-regex
  /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i

function checkElement(element: MdxNode) {
  const name = element.name ?? ""
  const tag = `<${name}>`

  // MDX renders only a name that starts with a lowercase letter as an HTML
  // tag, and the DOM matches tag names case-insensitively, so `<iFrame>` is an
  // iframe. Any other name is a block from MDX_COMPONENTS: `<Iframe>` is the
  // Iframe block, and `<IFRAME>` fails to render as an unknown block.
  if (/^[a-z]/.test(name) && BLOCKED_ELEMENTS.has(name.toLowerCase())) {
    throw notAllowed(element, `${tag} elements are not allowed in runbooks.`)
  }
  if (name.includes(".")) {
    throw notAllowed(
      element,
      `dotted element names like ${tag} are not allowed in runbooks. Use the block name on its own.`,
    )
  }
  if (name.includes("-")) {
    throw notAllowed(element, `custom elements like ${tag} are not allowed in runbooks.`)
  }
  // Inside `<svg>`, React creates `<svg:script>` with createElementNS, which
  // yields a real script element (local name `script`) that runs when mounted.
  // Rejecting every prefix is simpler and fails closed.
  if (name.includes(":")) {
    throw notAllowed(element, `namespaced element names like ${tag} are not allowed in runbooks.`)
  }

  for (const attribute of element.attributes ?? []) {
    if (attribute.type === "mdxJsxExpressionAttribute") {
      throw notAllowed(
        attribute,
        `spread props like {${excerpt(attribute.value)}} on ${tag} are not allowed in runbooks. Pass each prop separately. ${LITERALS_HINT}`,
      )
    }

    if (BLOCKED_PROPS.has(attribute.name?.toLowerCase() ?? "")) {
      throw notAllowed(
        attribute,
        `the \`${attribute.name}\` prop of ${tag} is not allowed in runbooks.`,
      )
    }

    // `prop="text"` and bare `prop` are plain strings/booleans; only
    // `prop={...}` carries an expression.
    const value = attribute.value
    if (typeof value === "object" && value !== null && !isLiteralProgram(value.data?.estree)) {
      throw notAllowed(
        attribute,
        `the \`${attribute.name}\` prop of ${tag} must be a literal value, not {${excerpt(value.value)}}. ${LITERALS_HINT}`,
      )
    }

    // An SVG animation's `values` is a `;`-separated list, so test each entry.
    if (
      propStrings(value).some((text) => text.split(";").some((entry) => JAVASCRIPT_URL.test(entry)))
    ) {
      throw notAllowed(
        attribute,
        `\`javascript:\` URLs like the \`${attribute.name}\` prop of ${tag} are not allowed in runbooks.`,
      )
    }
  }
}

// The strings a prop value can put in the DOM: a plain string, or the strings
// in a literal `{...}` value. React writes an array as its comma-joined items,
// so `HREF={['javascript:...']}` counts too.
function propStrings(value: MdxNode["value"]): string[] {
  if (typeof value === "string") return [value]
  const statement = value?.data?.estree?.body[0]
  return statement?.type === "ExpressionStatement" ? literalStrings(statement.expression) : []
}

function literalStrings(node: EstreeNode | null): string[] {
  switch (node?.type) {
    case "Literal":
      return typeof node.value === "string" ? [node.value] : []
    case "TemplateLiteral":
      return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw)
    case "ArrayExpression":
      return node.elements.flatMap(literalStrings)
    default:
      return []
  }
}

// An expression's program is literal-only when it is empty (`{}` or
// `{/* comment */}`) or a single expression statement whose expression is a
// literal value. A missing program (no estree) fails closed.
function isLiteralProgram(program: Program | null | undefined): boolean {
  if (!program) return false
  const [statement, ...rest] = program.body
  if (!statement) return true
  if (rest.length > 0) return false
  return statement.type === "ExpressionStatement" && isLiteralValue(statement.expression)
}

function isLiteralValue(node: EstreeNode | null): boolean {
  if (!node) return false // array hole: `[1, , 2]`
  switch (node.type) {
    case "Literal":
      return true
    case "TemplateLiteral":
      return node.expressions.length === 0
    case "UnaryExpression":
      return (
        (node.operator === "-" || node.operator === "+") &&
        node.argument.type === "Literal" &&
        typeof node.argument.value === "number"
      )
    case "ArrayExpression":
      return node.elements.every(isLiteralValue)
    case "ObjectExpression":
      return node.properties.every(
        (property) =>
          property.type === "Property" &&
          property.kind === "init" &&
          !property.computed &&
          !property.method &&
          !isProtoKey(property.key) &&
          isLiteralValue(property.value),
      )
    default:
      return false
  }
}

// `{ __proto__: x }` and `{ '__proto__': x }` set the object's prototype
// rather than a property.
function isProtoKey(key: EstreeNode): boolean {
  return (
    (key.type === "Identifier" && key.name === "__proto__") ||
    (key.type === "Literal" && key.value === "__proto__")
  )
}

function notAllowed(node: MdxNode, reason: string): Error {
  const line = node.position?.start.line
  return new Error(line ? `Line ${line}: ${reason}` : reason)
}

// A short, single-line excerpt of the offending source for error messages.
function excerpt(source: MdxNode["value"]): string {
  const text = typeof source === "string" ? source.replace(/\s+/g, " ").trim() : ""
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}
