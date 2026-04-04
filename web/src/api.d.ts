interface RunbooksAPI {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  on(channel: string, callback: (...args: unknown[]) => void): () => void
  once(channel: string, callback: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    api: RunbooksAPI
  }
}

export {}
