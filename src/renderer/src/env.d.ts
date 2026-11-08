/// <reference types="vite/client" />

import type { AerieApi } from '../../shared/types'

declare global {
  interface Window {
    aerie: AerieApi
  }
}

export {}
