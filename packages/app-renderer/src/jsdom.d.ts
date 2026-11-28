// jsdom ships no types, and the repo holds no @types/jsdom: the part of it testDom.ts uses.
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string, options: { readonly url: string })
    readonly window: Window & typeof globalThis
  }
}
