/**
 * Style variables for diff/file rendering containers.
 * These CSS custom properties are set on the wrapping div via inline style,
 * ensuring the child components (DiffViewer, FileViewer) inherit them.
 */

export const styleVariables = {
  "--diffs-font-family": "var(--font-family-mono)",
  "--diffs-font-size": "var(--font-size-small)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": 2,
  "--diffs-font-features": "var(--font-family-mono--font-feature-settings)",
  "--diffs-header-font-family": "var(--font-family-sans)",
  "--diffs-gap-block": 0,
  "--diffs-min-number-column-width": "4ch",
}
