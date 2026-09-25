import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { evaluate } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'
import { TestWrapper } from '@/test/test-utils'
import MDXContainer, { rehypeTransformAssetPaths } from '../MDXContainer'

function renderRunbook(content: string) {
  return render(
    <TestWrapper>
      <MDXContainer content={content} runbookPath="testdata/demo/assets" />
    </TestWrapper>,
  )
}

// Waits for the MDX to compile and render, then returns the first element that
// matches `selector` inside the runbook body.
async function findInRunbook(selector: string): Promise<Element> {
  const body = await screen.findByTestId('runbook-content')
  return waitFor(() => {
    const el = body.querySelector(selector)
    expect(el).not.toBeNull()
    return el!
  })
}

describe('MDXContainer asset paths', () => {
  it('rewrites markdown image and link syntax', async () => {
    renderRunbook('![Diagram](./assets/a.png)\n\n[Guide](./assets/guide.pdf)\n')

    expect((await findInRunbook('img[alt="Diagram"]')).getAttribute('src')).toBe('runbook-asset://assets/a.png')
    expect((await screen.findByText('Guide')).closest('a')?.getAttribute('href')).toBe('runbook-asset://assets/guide.pdf')
  })

  it('rewrites an inline JSX <img> (mdxJsxTextElement) and keeps its other attributes', async () => {
    renderRunbook('Status icon <img src="./assets/b.png" width="200" alt="b" /> inline.\n')

    const img = await findInRunbook('img[alt="b"]')
    expect(img.getAttribute('src')).toBe('runbook-asset://assets/b.png')
    expect(img.getAttribute('width')).toBe('200')
  })

  it('rewrites a block JSX <video> with poster and nested <source> (mdxJsxFlowElement)', async () => {
    renderRunbook(
      '<video src="./assets/c.mp4" poster="./assets/p.png" controls>\n' +
        '  <source src="./assets/d.webm" type="video/webm" />\n' +
        '</video>\n',
    )

    const video = await findInRunbook('video')
    expect(video.getAttribute('src')).toBe('runbook-asset://assets/c.mp4')
    expect(video.getAttribute('poster')).toBe('runbook-asset://assets/p.png')
    expect(video.querySelector('source')?.getAttribute('src')).toBe('runbook-asset://assets/d.webm')
  })

  it('rewrites JSX <audio>, <a>, <embed> and <object> asset URLs', async () => {
    renderRunbook(
      '<audio src="./assets/e.mp3" controls />\n\n' +
        'Download the <a href="./assets/f.pdf">guide</a>.\n\n' +
        '<embed src="./assets/g.pdf" type="application/pdf" />\n\n' +
        '<object data="./assets/h.pdf" type="application/pdf" />\n',
    )

    expect((await findInRunbook('audio')).getAttribute('src')).toBe('runbook-asset://assets/e.mp3')
    expect((await screen.findByText('guide')).closest('a')?.getAttribute('href')).toBe('runbook-asset://assets/f.pdf')
    expect((await findInRunbook('embed')).getAttribute('src')).toBe('runbook-asset://assets/g.pdf')
    expect((await findInRunbook('object')).getAttribute('data')).toBe('runbook-asset://assets/h.pdf')
  })

  it('leaves URLs outside ./assets/ unchanged', async () => {
    renderRunbook(
      '<img src="https://example.com/x.png" alt="remote" />\n\n' +
        '<img src="./images/y.png" alt="other-dir" />\n',
    )

    expect((await findInRunbook('img[alt="remote"]')).getAttribute('src')).toBe('https://example.com/x.png')
    expect((await findInRunbook('img[alt="other-dir"]')).getAttribute('src')).toBe('./images/y.png')
  })
})

describe('rehypeTransformAssetPaths', () => {
  // No block takes a src/href/data/poster prop today, so exercise the plugin
  // through a real MDX compile with a probe component that echoes its props.
  it('leaves props on capitalized components alone', async () => {
    const { default: Content } = await evaluate(
      '<Probe src="./assets/x.png" href="./assets/y.pdf" />\n\n<img src="./assets/z.png" alt="z" />\n',
      { ...runtime, rehypePlugins: [rehypeTransformAssetPaths] },
    )
    const Probe = ({ src, href }: { src?: string; href?: string }) => (
      <span data-testid="probe" data-src={src} data-href={href} />
    )

    const { container } = render(<Content components={{ Probe }} />)

    const probe = screen.getByTestId('probe')
    expect(probe.getAttribute('data-src')).toBe('./assets/x.png')
    expect(probe.getAttribute('data-href')).toBe('./assets/y.pdf')
    // The plugin did run: the sibling HTML tag was rewritten.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('runbook-asset://assets/z.png')
  })
})
