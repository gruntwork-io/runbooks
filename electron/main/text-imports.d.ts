// Files the main process imports `with { type: "text" }`, as their contents.
// Bun loads them this way natively (bun test); the textImports plugin in
// electron.vite.config.ts does the same for the build.
declare module "*.sh" {
  const text: string
  export default text
}

declare module "*.cmd" {
  const text: string
  export default text
}
