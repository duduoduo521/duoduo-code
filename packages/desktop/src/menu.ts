// Native menu has been replaced by the cross-platform HTML menu bar
// (packages/app/src/components/titlebar-menu.tsx).
//
// Kept as a no-op for backward compatibility — createMenu is still called
// from index.tsx but does nothing now that the HTML menu handles all platforms.

export async function createMenu(_trigger: (id: string) => void) {
  // Native menu disabled — using HTML menu bar instead
}
