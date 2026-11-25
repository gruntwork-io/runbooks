/**
 * What keeps runbook MDX declarative: every construct that would run
 * JavaScript, or hand the app raw HTML or another document to load, is
 * refused at parse time, before any client shows the runbook.
 *
 * The renderer no longer evaluates MDX, but it still renders HTML elements
 * and their props, so the element and prop checks still matter:
 * - `import` / `export` statements;
 * - spread props such as `<Command {...props} />`;
 * - `{...}` in text or between blocks, unless it is empty, a comment, or a
 *   literal value;
 * - `prop={...}` values that are not literal values;
 * - elements that load scripts or embed documents (BLOCKED_ELEMENTS);
 * - custom elements (`<x-widget>`), whose props React passes through as DOM
 *   attributes, so `ONANIMATIONSTART="..."` becomes an inline handler;
 * - dotted element names, which reach properties of a block;
 * - namespaced element names, because `<svg><svg:script>` creates a real
 *   script element that slips past a check on the name `script`;
 * - props and object keys that inject raw HTML or replace a prototype
 *   (BLOCKED_PROPS);
 * - `javascript:` URLs in any prop, because React only neutralizes them in
 *   props spelled exactly `href`, `src`, `action`, `formAction` or
 *   `xlinkHref`.
 *
 * A literal value is a string, number, boolean, null or regex literal; a
 * template string without `${...}`; a number with a leading `-` or `+`; or an
 * array or object made only of literal values.
 *
 * The ESM and expression checks are an allowlist and fail closed. The element
 * and prop checks are a denylist of the known routes from literal markup to
 * script: defense in depth on top of the renderer's sandbox, context
 * isolation, CSP and navigation guard, not a complete HTML sanitizer.
 *
 * Ported from src/remarkLiteralOnly.ts, which threw on the first problem.
 * This reports every one, as the parser reports all errors in one pass.
 */
import type { Node as EstreeNode, Program } from "estree"
import type { MdxNode } from "./mdx.ts"

/** One construct the check refuses. */
export interface Refusal {
  /** The node to point at: the element, the attribute, the expression. */
  readonly node: MdxNode
  readonly message: string
  /** The element's name, when the refusal is about an element or its prop. */
  readonly element?: string
  readonly prop?: string
}

const LITERALS_HINT =
  "Only literal values are allowed: strings, numbers, booleans, null, template strings without ${...}, and arrays or objects of those."

/** Every construct in `tree` that would run code or load a document, in document order. */
export function refusals(tree: MdxNode): ReadonlyArray<Refusal> {
  const found: Refusal[] = []
  const visit = (node: MdxNode) => {
    switch (node.type) {
      case "mdxjsEsm":
        found.push({
          node,
          message: `\`import\` and \`export\` statements are not allowed in runbooks. Remove "${excerpt(node.value)}".`,
        })
        break
      case "mdxFlowExpression":
      case "mdxTextExpression":
        if (!isLiteralProgram(node.data?.estree)) {
          found.push({
            node,
            message: `the expression {${excerpt(node.value)}} is not allowed in runbooks. ${LITERALS_HINT}`,
          })
        }
        break
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement":
        found.push(...elementRefusals(node))
        break
    }
    node.children?.forEach(visit)
  }
  visit(tree)
  return found
}

// Elements that load and run scripts or embed other documents. Compared lowercased.
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
// `dangerouslySetInnerHTML` and `srcDoc` inject raw HTML; `__proto__`
// replaces the prototype of the props it appears in.
const BLOCKED_PROPS = new Set(["dangerouslysetinnerhtml", "srcdoc", "__proto__"])

// A `javascript:` scheme as browsers parse one: tabs and newlines inside it are ignored.
const JAVASCRIPT_SCHEME =
  /^j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i

/** A `javascript:` URL: browsers skip leading control characters and spaces, U+0000 to U+0020. */
function isJavascriptUrl(text: string): boolean {
  let start = 0
  while (start < text.length && text.charCodeAt(start) <= 0x20) start++
  return JAVASCRIPT_SCHEME.test(text.slice(start))
}

function elementRefusals(element: MdxNode): Refusal[] {
  const name = element.name ?? ""
  const tag = `<${name}>`
  const found: Refusal[] = []
  const refuse = (message: string) => found.push({ node: element, message, element: name })

  // Only a name that starts with a lowercase letter is an HTML element, and
  // the DOM matches tag names case-insensitively. `<Iframe>` is a block.
  if (/^[a-z]/.test(name) && BLOCKED_ELEMENTS.has(name.toLowerCase())) {
    refuse(`${tag} elements are not allowed in runbooks.`)
  }
  if (name.includes(".")) {
    refuse(
      `dotted element names like ${tag} are not allowed in runbooks. Use the block name on its own.`,
    )
  }
  if (name.includes("-")) refuse(`custom elements like ${tag} are not allowed in runbooks.`)
  if (name.includes(":")) {
    refuse(`namespaced element names like ${tag} are not allowed in runbooks.`)
  }

  for (const attribute of element.attributes ?? []) {
    const prop = attribute.name ?? ""
    const refuseProp = (message: string) =>
      found.push({ node: attribute, message, element: name, prop })

    if (attribute.type === "mdxJsxExpressionAttribute") {
      found.push({
        node: attribute,
        element: name,
        message: `spread props like {${excerpt(attribute.value)}} on ${tag} are not allowed in runbooks. Pass each prop separately. ${LITERALS_HINT}`,
      })
      continue
    }
    if (BLOCKED_PROPS.has(prop.toLowerCase())) {
      refuseProp(`the \`${prop}\` prop of ${tag} is not allowed in runbooks.`)
    }
    const value = attribute.value
    if (typeof value === "object" && value !== null && !isLiteralProgram(value.data?.estree)) {
      refuseProp(
        `the \`${prop}\` prop of ${tag} must be a literal value, not {${excerpt(value.value)}}. ${LITERALS_HINT}`,
      )
    }
    // An SVG animation's `values` is a `;`-separated list, so test each entry.
    if (propStrings(value).some((text) => text.split(";").some(isJavascriptUrl))) {
      refuseProp(
        `\`javascript:\` URLs like the \`${prop}\` prop of ${tag} are not allowed in runbooks.`,
      )
    }
  }
  return found
}

// The strings a prop value can put in the DOM: a plain string, or the strings
// in a literal `{...}` value. React writes an array as its comma-joined items.
function propStrings(value: MdxNode["value"]): string[] {
  if (typeof value === "string") return [value]
  const statement = value?.data?.estree?.body[0]
  return statement?.type === "ExpressionStatement" ? literalStrings(statement.expression) : []
}

function literalStrings(node: EstreeNode | null): string[] {
  if (node?.type === "Literal") return typeof node.value === "string" ? [node.value] : []
  if (node?.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw)
  }
  if (node?.type === "ArrayExpression") return node.elements.flatMap(literalStrings)
  return []
}

// Literal-only: empty (`{}`, `{/* comment */}`) or one expression statement
// whose expression is a literal value. No program fails closed.
function isLiteralProgram(program: Program | null | undefined): boolean {
  if (!program) return false
  const [statement, ...rest] = program.body
  if (!statement) return true
  if (rest.length > 0) return false
  return statement.type === "ExpressionStatement" && isLiteralValue(statement.expression)
}

function isLiteralValue(node: EstreeNode | null): boolean {
  if (!node) return false // array hole: `[1, , 2]`
  if (node.type === "Literal") return true
  if (node.type === "TemplateLiteral") return node.expressions.length === 0
  if (node.type === "UnaryExpression") {
    return (
      (node.operator === "-" || node.operator === "+") &&
      node.argument.type === "Literal" &&
      typeof node.argument.value === "number"
    )
  }
  if (node.type === "ArrayExpression") return node.elements.every(isLiteralValue)
  if (node.type === "ObjectExpression") {
    return node.properties.every(
      (property) =>
        property.type === "Property" &&
        property.kind === "init" &&
        !property.computed &&
        !property.method &&
        !isProtoKey(property.key) &&
        isLiteralValue(property.value),
    )
  }
  return false
}

// `{ __proto__: x }` and `{ '__proto__': x }` set the object's prototype.
function isProtoKey(key: EstreeNode): boolean {
  return (
    (key.type === "Identifier" && key.name === "__proto__") ||
    (key.type === "Literal" && key.value === "__proto__")
  )
}

// A short, single-line excerpt of the offending source.
function excerpt(source: MdxNode["value"]): string {
  const text = typeof source === "string" ? source.replace(/\s+/g, " ").trim() : ""
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}
