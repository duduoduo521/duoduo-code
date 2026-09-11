import { getFileExtension } from "./path"

export type PreviewKind = "markdown" | "image" | "csv" | "json" | "pdf" | "office"

export interface PreviewCapability {
  kind: PreviewKind
  /**
   * textBased=true  → has an editable source view (CodeMirror): md/csv/json/svg/code.
   * textBased=false → preview only, never mounts CodeMirror: pdf/doc/xls/image.
   */
  textBased: boolean
  /**
   * previewable=true → provides a "preview" mode (the matching FilePreview renderer).
   * When textBased is true it is a "source + preview" dual mode (md/csv/json/svg);
   * when false it is a pure preview (pdf/doc/xls/image).
   */
  previewable: boolean
}

const MAP: Record<string, PreviewCapability> = {
  md: { kind: "markdown", textBased: true, previewable: true },
  markdown: { kind: "markdown", textBased: true, previewable: true },
  png: { kind: "image", textBased: false, previewable: true },
  jpg: { kind: "image", textBased: false, previewable: true },
  jpeg: { kind: "image", textBased: false, previewable: true },
  gif: { kind: "image", textBased: false, previewable: true },
  webp: { kind: "image", textBased: false, previewable: true },
  bmp: { kind: "image", textBased: false, previewable: true },
  ico: { kind: "image", textBased: false, previewable: true },
  avif: { kind: "image", textBased: false, previewable: true },
  // svg: preview only. The backend returns svg as base64 (image extension),
  // so a CodeMirror "source" view would show base64 garbage — render it via
  // <object> (interactive) in the preview channel instead.
  svg: { kind: "image", textBased: false, previewable: true },
  csv: { kind: "csv", textBased: true, previewable: true },
  json: { kind: "json", textBased: true, previewable: true },
  pdf: { kind: "pdf", textBased: false, previewable: true },
  doc: { kind: "office", textBased: false, previewable: true },
  docx: { kind: "office", textBased: false, previewable: true },
  xls: { kind: "office", textBased: false, previewable: true },
  xlsx: { kind: "office", textBased: false, previewable: true },
  // ppt/pptx intentionally absent → not previewed, keep original behavior.
}

export const getCapability = (path: string): PreviewCapability | undefined => {
  const ext = getFileExtension(path)
  return ext ? MAP[ext.toLowerCase()] : undefined
}
