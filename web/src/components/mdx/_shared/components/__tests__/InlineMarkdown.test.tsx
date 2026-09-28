import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { InlineMarkdown } from '../InlineMarkdown'

// Block titles, descriptions and messages render through InlineMarkdown, not
// the MDX compiler, so they need the same ./assets/ rewrite as the runbook body.
describe('InlineMarkdown asset paths', () => {
  it('rewrites ./assets/ image and link URLs to runbook-asset://', () => {
    const { container } = render(
      <InlineMarkdown>{'![Diagram](./assets/d.png) and [guide](./assets/g.pdf)'}</InlineMarkdown>,
    )

    expect(container.querySelector('img')?.getAttribute('src')).toBe('runbook-asset://assets/d.png')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('runbook-asset://assets/g.pdf')
  })

  it('keeps react-markdown URL sanitizing for every other URL', () => {
    const { container } = render(
      <InlineMarkdown>
        {'[site](https://example.com/a) ![other](./images/y.png) [bad](javascript:alert(1))'}
      </InlineMarkdown>,
    )

    const links = container.querySelectorAll('a')
    expect(links[0].getAttribute('href')).toBe('https://example.com/a')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('./images/y.png')
    // defaultUrlTransform blanks unsafe schemes
    expect(links[1].getAttribute('href')).toBe('')
  })
})
