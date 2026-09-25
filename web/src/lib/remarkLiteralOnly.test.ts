import { describe, it, expect } from 'vitest'
import { compile } from '@mdx-js/mdx'
import remarkGfm from 'remark-gfm'
import { remarkLiteralOnly } from './remarkLiteralOnly'

// Compile only (no evaluation) with the same remark pipeline as MDXContainer.
const compileRunbook = (source: string) =>
  compile(source, { remarkPlugins: [remarkGfm, remarkLiteralOnly] })

describe('remarkLiteralOnly', () => {
  describe('allows literal-only MDX', () => {
    it.each([
      ['plain string props', '<Admonition type="info" title="Heads up" />'],
      ['bare boolean props', '<Admonition allowPermanentHide />'],
      ['boolean expressions', '<TemplateInline generateFile={true} />'],
      ['string expressions', `<Command id={'a'} command={"echo hi"} />`],
      ['template strings without substitutions', '<Command command={`echo "$HOME" > "$GENERATED_FILES/x"`} />'],
      ['signed numbers, null and regexes', '<X a={-1} b={+2.5} c={0} d={null} e={/ab+c/i} />'],
      ['arrays of literals', '<Command args={["a", "b", 3]} />'],
      ['nested objects and arrays', `<AwsAuth detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']} />`],
      ['quoted object keys', `<X a={{ 'quoted-key': 1, plain: [true, false] }} />`],
      ['comments', 'Before\n\n{/* a comment */}\n\nInline {/* comment */} text'],
      ['empty expressions', 'Before\n\n{}\n\nAfter'],
      ['literal text and flow expressions', `Price: {'$5'}\n\n{"A literal paragraph"}`],
      ['nested blocks', '<Admonition title="Outer">\n  <Command args={["x"]} />\n</Admonition>'],
      ['plain HTML elements', '<div style="color: red;">\nRed text\n</div>\n\nInline <img src="./x.png" alt="x" /> image'],
      ['object keys that only resemble __proto__', `<X a={{ proto: 1, '__proto': 2, constructor: 3 }} />`],
    ])('%s', async (_name, source) => {
      await expect(compileRunbook(source)).resolves.toBeDefined()
    })
  })

  describe('rejects anything that runs JavaScript', () => {
    it.each([
      ['an export', 'export const x = 1'],
      ['an import', "import x from './x.js'"],
      ['a call in a flow expression', '{alert(1)}'],
      ['a call in a text expression', 'Hello {name()} there'],
      ['an identifier', '{window}'],
      ['a member expression', '{window.api}'],
      ['a binary expression', '{1 + 1}'],
      ['a sequence expression', '{(1, alert(1))}'],
      ['a call in a prop', '<X a={f()} />'],
      ['an identifier prop', '<X a={undefined} />'],
      ['a template substitution', '<X a={`${f()}`} />'],
      ['a spread prop', '<X {...props} />'],
      ['an array spread', '<X a={[...xs]} />'],
      ['an array hole', '<X a={[1, , 2]} />'],
      ['a computed object key', '<X a={{ [k]: 1 }} />'],
      ['a shorthand property', '<X a={{ k }} />'],
      ['an object method', '<X a={{ m() { return 1 } }} />'],
      ['a getter', '<X a={{ get g() { return 1 } }} />'],
      ['an object spread', '<X a={{ ...o }} />'],
      ['an arrow function', '<X a={() => 1} />'],
      ['a negated identifier', '<X a={-x} />'],
      ['a non-numeric unary', '<X a={!0} />'],
      ['a call nested in a literal', '<X a={[{ b: f() }]} />'],
      ['a call in nested block children', '<Admonition>\n  {f()}\n</Admonition>'],
      ['a script element', '<script async src="file:///tmp/x.js" />'],
      ['an iframe element', '<iframe src="./page.html" />'],
      ['a frame element', '<frame src="./page.html" />'],
      ['an object element', '<object data="./page.html" />'],
      ['an embed element', '<embed src="./page.svg" />'],
      ['an uppercase blocked element', '<IFRAME src="./page.html" />'],
      ['dangerouslySetInnerHTML', `<div dangerouslySetInnerHTML={{ __html: '<img src=x onerror="alert(1)">' }} />`],
      ['a srcDoc prop', `<div srcDoc="<script>alert(1)</script>" />`],
      ['a lowercase srcdoc prop', `Inline <span srcdoc="<script>alert(1)</script>" /> text`],
      ['a custom element', '<x-widget style={{ animationName: "spin" }} ONANIMATIONSTART="alert(1)" />'],
      ['a custom element in text', 'Hello <x-widget oNfocus="alert(1)" /> there'],
      ['a dotted element name', '<Admonition.constructor />'],
      ['a namespaced script element', '<svg>\n  <svg:script href="file:///tmp/x.js" />\n</svg>'],
      ['a namespaced script element with inline code', "<svg><svg:script>window.pwned = 'x'</svg:script></svg>"],
      ['a namespaced element with another prefix', '<svg><html:script href="file:///tmp/x.js" /></svg>'],
      ['a __proto__ prop', '<Admonition __proto__={["a=1"]} />'],
      ['a __proto__ object key', '<X a={{ __proto__: ["a=1"] }} />'],
      ['a quoted __proto__ object key', `<X a={[{ '__proto__': { b: 1 } }]} />`],
    ])('%s', async (_name, source) => {
      await expect(compileRunbook(source)).rejects.toThrow(/not allowed in runbooks|must be a literal value/)
    })
  })

  it('names the line, prop and block in the error', async () => {
    await expect(compileRunbook('# Title\n\n<Command id="a" command={run()} />')).rejects.toThrow(
      /^Line 3: the `command` prop of <Command> must be a literal value, not \{run\(\)\}\./,
    )
    await expect(compileRunbook('# Title\n\nexport const x = 1')).rejects.toThrow(
      /^Line 3: `import` and `export` statements are not allowed in runbooks\. Remove "export const x = 1"\./,
    )
    await expect(compileRunbook('# Title\n\n<div srcDoc="x" />')).rejects.toThrow(
      /^Line 3: the `srcDoc` prop of <div> is not allowed in runbooks\./,
    )
  })
})
