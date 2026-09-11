declare module "marked-katex-extension" {
  interface MarkedKatexExtensionOptions {
    nonStandard?: boolean
    throwOnError?: boolean
    output?: string
    katexOptions?: Record<string, unknown>
  }
  export default function markedKatex(options?: MarkedKatexExtensionOptions): object
}
