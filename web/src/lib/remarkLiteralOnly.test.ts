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
  })
})
