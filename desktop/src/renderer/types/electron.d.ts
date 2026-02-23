import type { RunbooksAPI } from '../../preload/index'

declare global {
  interface Window {
    runbooks: RunbooksAPI
  }
}
