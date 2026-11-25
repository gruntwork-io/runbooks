// Minimal ambient declaration for the `ini` package (no @types/ini available).
declare module "ini" {
  export function parse(text: string): Record<string, Record<string, string>>
  export function stringify(obj: Record<string, unknown>, options?: { section?: string }): string
}
