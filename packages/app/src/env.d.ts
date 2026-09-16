/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DUODUO_SERVER_HOST: string
  readonly VITE_DUODUO_SERVER_PORT: string
  readonly VITE_DUODUO_CHANNEL?: "dev" | "beta" | "prod"
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
