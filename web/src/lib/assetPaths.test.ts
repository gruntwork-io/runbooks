import { describe, it, expect } from 'vitest'
import { rewriteAssetUrl } from './assetPaths'

// The open runbook's runbook-asset:// host, as runbook:get sends it.
const rewrite = (tagName: string, attribute: string, value: string) =>
  rewriteAssetUrl(tagName, attribute, value, 'rtest')

describe('rewriteAssetUrl', () => {
  it('rewrites ./assets/ URLs in the listed attributes only', () => {
    expect(rewrite('img', 'src', './assets/a.png')).toBe('runbook-asset://rtest/a.png')
    expect(rewrite('video', 'poster', './assets/p.png')).toBe('runbook-asset://rtest/p.png')
    expect(rewrite('track', 'src', './assets/c.vtt')).toBe('runbook-asset://rtest/c.vtt')
    expect(rewrite('img', 'alt', './assets/a.png')).toBe('./assets/a.png')
    expect(rewrite('div', 'src', './assets/a.png')).toBe('./assets/a.png')
    expect(rewrite('constructor', 'src', './assets/a.png')).toBe('./assets/a.png')
    expect(rewrite('img', 'src', 'assets/a.png')).toBe('assets/a.png')
  })

  it("rewrites nothing without the runbook's host", () => {
    expect(rewriteAssetUrl('img', 'src', './assets/a.png', undefined)).toBe('./assets/a.png')
  })

  it('matches attribute names case-insensitively', () => {
    expect(rewrite('img', 'SRC', './assets/a.png')).toBe('runbook-asset://rtest/a.png')
    expect(rewrite('img', 'srcset', './assets/a.png 2x')).toBe('runbook-asset://rtest/a.png 2x')
    expect(rewrite('source', 'srcSet', './assets/a.webp')).toBe('runbook-asset://rtest/a.webp')
  })

  describe('srcSet', () => {
    const srcSet = (value: string) => rewrite('img', 'srcSet', value)

    it('rewrites each candidate URL and keeps descriptors and spacing', () => {
      expect(srcSet('./assets/a.png 1x, ./assets/a@2x.png 2x')).toBe(
        'runbook-asset://rtest/a.png 1x, runbook-asset://rtest/a@2x.png 2x',
      )
      expect(srcSet('./assets/s.png 480w,\n  ./assets/l.png 1080w')).toBe(
        'runbook-asset://rtest/s.png 480w,\n  runbook-asset://rtest/l.png 1080w',
      )
      expect(srcSet('./assets/a.png,./assets/b.png 2x')).toBe('runbook-asset://rtest/a.png,runbook-asset://rtest/b.png 2x')
    })

    it('leaves candidates outside ./assets/ unchanged', () => {
      expect(srcSet('https://example.com/a.png 1x, ./assets/b.png 2x')).toBe(
        'https://example.com/a.png 1x, runbook-asset://rtest/b.png 2x',
      )
      // A comma inside a URL splits it, but only a piece starting with ./assets/ changes
      expect(srcSet('data:image/png;base64,iVBORw0KGgo= 1x')).toBe('data:image/png;base64,iVBORw0KGgo= 1x')
    })
  })
})
