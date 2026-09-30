import { describe, it, expect, afterEach } from 'vitest'
import { findTextRanges, firstMatchInView, indexAtOrAfter } from './findInPage'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

const texts = (ranges: Range[]) => ranges.map((r) => r.toString())

afterEach(() => {
  document.body.innerHTML = ''
})

describe('findTextRanges', () => {
  it('matches case-insensitively, several times in one text node', () => {
    const root = mount('<p>Alpha beta ALPHA alpha</p>')
    expect(texts(findTextRanges(root, 'alpha'))).toEqual(['Alpha', 'ALPHA', 'alpha'])
  })

  it('finds a match that spans inline elements', () => {
    const root = mount('<p>run <code>aws <span>s3</span> ls</code> now</p>')
    const ranges = findTextRanges(root, 'aws s3 ls')
    expect(texts(ranges)).toEqual(['aws s3 ls'])
    expect(texts(findTextRanges(root, 'run aws'))).toEqual(['run aws'])
  })

  it('does not match across block boundaries', () => {
    const root = mount('<p>foo</p><p>bar</p><div>baz<div></div>qux</div><div><p>one</p>two</div>')
    expect(findTextRanges(root, 'foobar')).toEqual([])
    expect(findTextRanges(root, 'bazqux')).toEqual([])
    expect(findTextRanges(root, 'onetwo')).toEqual([])
    expect(texts(findTextRanges(root, 'baz'))).toEqual(['baz'])
  })

  it('does not match across a line break', () => {
    const root = mount('<p>first<br>second</p>')
    expect(findTextRanges(root, 'firstsecond')).toEqual([])
    expect(texts(findTextRanges(root, 'second'))).toEqual(['second'])
  })

  it('treats a space in the query as any run of whitespace', () => {
    // Markdown keeps a paragraph's soft line breaks in its text node, where
    // they render as a single space.
    const root = mount('<p>deploy the\nlambda   function</p>')
    expect(texts(findTextRanges(root, 'the lambda function'))).toEqual(['the\nlambda   function'])
  })

  it('treats regex-special characters literally', () => {
    const root = mount('<p>axb a.b (x) [y] $HOME a*b</p>')
    expect(texts(findTextRanges(root, 'a.b'))).toEqual(['a.b'])
    expect(texts(findTextRanges(root, '(x)'))).toEqual(['(x)'])
    expect(texts(findTextRanges(root, '[y]'))).toEqual(['[y]'])
    expect(texts(findTextRanges(root, '$home'))).toEqual(['$HOME'])
    expect(texts(findTextRanges(root, 'a*b'))).toEqual(['a*b'])
  })

  it('returns nothing for an empty or whitespace-only query', () => {
    const root = mount('<p>some text</p>')
    expect(findTextRanges(root, '')).toEqual([])
    expect(findTextRanges(root, '   ')).toEqual([])
  })

  it('skips ignored subtrees, scripts, styles, textareas and inert content', () => {
    const root = mount(
      '<p>needle</p>' +
        '<div data-find-ignore><span>needle</span></div>' +
        '<script>var needle = 1</script>' +
        '<style>.needle {}</style>' +
        '<textarea>needle</textarea>' +
        '<div inert><p>needle</p></div>',
    )
    const ranges = findTextRanges(root, 'needle')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('P')
  })

  it('skips text whose element is not rendered', () => {
    const root = mount('<p>needle</p><div class="collapsed"><span>needle</span></div>')
    const hidden = root.querySelector<HTMLElement>('.collapsed span')!
    // jsdom has no layout, so stub the answer Chromium would give for a
    // display:none subtree.
    hidden.checkVisibility = () => false
    expect(findTextRanges(root, 'needle')).toHaveLength(1)
  })

  it('returns ranges whose text is the matched text, in document order', () => {
    const root = mount('<ul><li>one <b>needle</b></li><li>two needle<i>s</i></li></ul><pre>needle</pre>')
    const ranges = findTextRanges(root, 'needle')
    expect(texts(ranges)).toEqual(['needle', 'needle', 'needle'])
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].compareBoundaryPoints(Range.START_TO_START, ranges[i - 1])).toBe(1)
    }
    expect(texts(findTextRanges(root, 'needles'))).toEqual(['needles'])
  })
})

describe('indexAtOrAfter', () => {
  it('picks the first match at or after the anchor, else the last one', () => {
    const root = mount('<p>needle</p><p>needle</p><p>needle</p>')
    const ranges = findTextRanges(root, 'needle')
    expect(indexAtOrAfter(ranges, ranges[1])).toBe(1)
    expect(indexAtOrAfter([], ranges[0])).toBe(-1)

    const after = document.createRange()
    after.selectNodeContents(root)
    after.collapse(false)
    expect(indexAtOrAfter(ranges, after)).toBe(2)
  })
})

describe('firstMatchInView', () => {
  it('falls back to the first match without layout', () => {
    const root = mount('<p>needle</p><p>needle</p>')
    expect(firstMatchInView(findTextRanges(root, 'needle'))).toBe(0)
    expect(firstMatchInView([])).toBe(-1)
  })
})
