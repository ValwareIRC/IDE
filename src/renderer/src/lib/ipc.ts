import type { PrismApi } from '@shared/ipc'

declare global {
  interface Window {
    prism: PrismApi
  }
}

export const prism: PrismApi = window.prism
