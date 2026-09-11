import type { FileContent } from "@duoduo-ai/sdk/v2"
import { useSDK } from "../sdk"

/**
 * Byte reader for the preview channel. Lives in `app` (not `ui`) because it
 * needs the SDK client; the returned callback is passed to `ui`'s FilePreview
 * via props so the ui package stays free of any sdk dependency.
 *
 * Crucially, this bypasses `file.tsx`'s load/store.content/touchFileContent so
 * preview bytes never pollute the shared editable-text LRU (see file.tsx guard).
 */
export function usePreviewContent() {
  const sdk = useSDK()
  return (path: string): Promise<FileContent | undefined> =>
    sdk.client.file.read({ path }).then((x) => x.data as FileContent | undefined)
}
