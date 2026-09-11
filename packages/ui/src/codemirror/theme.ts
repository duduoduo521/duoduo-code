import { EditorView } from "@codemirror/view"

/**
 * CodeMirror 6 theme that maps to the project's CSS variable system.
 * Uses CSS variables so theme switches are handled automatically.
 *
 * Covers: editor chrome, gutters, cursor, selections, search panel,
 * fold gutter, tooltips, scrollbars, and special character highlights.
 */
export const codeMirrorTheme = EditorView.theme(
  {
    // ── Editor root ────────────────────────────────────────────────
    "&": {
      height: "100%",
      backgroundColor: "var(--background-base)",
      // The code surface reads as a recess the text sits inside, lit by the
      // same overhead source as everything else. Kept to a hint — see
      // --light-editor-recess for why this is the faintest step in the scale.
      boxShadow: "var(--light-editor-recess)",
      color: "var(--text-strong)",
      fontSize: "var(--editor-font-size, 13px)",
      fontFamily: "var(--font-family-mono)",
      fontFeatureSettings: "var(--font-family-mono--font-feature-settings, normal)",
      lineHeight: "var(--editor-line-height, 24px)",
    },

    // ── Content area ───────────────────────────────────────────────
    ".cm-content": {
      fontFamily: "var(--font-family-mono)",
      fontFeatureSettings: "var(--font-family-mono--font-feature-settings, normal)",
      caretColor: "var(--text-interactive-base)",
      padding: "4px 16px 4px 0",
    },

    // ── Native text selection (used because drawSelection is disabled) ──
    // Behaves exactly like a <textarea>: browser/system default highlight.
    ".cm-content ::selection": {
      backgroundColor: "color-mix(in oklab, var(--text-interactive-base) 26%, transparent)",
    },
    ".cm-content::selection": {
      backgroundColor: "color-mix(in oklab, var(--text-interactive-base) 26%, transparent)",
    },

    // ── Cursor ─────────────────────────────────────────────────────
    ".cm-cursor": {
      borderLeftColor: "var(--text-interactive-base)",
      borderLeftWidth: "2px",
    },

    // ── Active line ────────────────────────────────────────────────
    ".cm-activeLine": {
      backgroundColor: "var(--surface-base)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--surface-raised-base)",
    },

    // ── Selection (legacy drawSelection class — kept transparent in case
    //    any extension still emits it; native ::selection above is the
    //    real source of truth now). ───────────────────────────────────
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "transparent",
    },

    // ── Gutters ────────────────────────────────────────────────────
    ".cm-gutters": {
      backgroundColor: "var(--surface-raised-base)",
      color: "var(--text-weak)",
      border: "none",
      paddingRight: "8px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      fontSize: "12px",
      lineHeight: "var(--editor-line-height, 24px)",
      minWidth: "2.5em",
      paddingRight: "8px",
      textAlign: "right",
    },

    // ── Code folding ───────────────────────────────────────────────
    ".cm-foldGutter": {
      width: "16px",
    },
    ".cm-foldGutter .cm-gutterElement": {
      cursor: "pointer",
      color: "var(--text-weak)",
      textAlign: "center",
    },
    ".cm-foldGutter .cm-gutterElement:hover": {
      color: "var(--text-strong)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--surface-raised-base)",
      color: "var(--text-weak)",
      border: "1px solid var(--border-weak-base)",
    },

    // ── Focus ──────────────────────────────────────────────────────
    "&.cm-focused": {
      outline: "none",
    },

    // ── Scroller ───────────────────────────────────────────────────
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "var(--font-family-mono)",
    },

    // ── Scrollbar (Webkit) ─────────────────────────────────────────
    ".cm-scroller::-webkit-scrollbar": {
      width: "8px",
      height: "8px",
    },
    ".cm-scroller::-webkit-scrollbar-track": {
      background: "transparent",
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      backgroundColor: "var(--border-weak-base)",
      borderRadius: "4px",
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": {
      backgroundColor: "var(--border-base)",
    },
    ".cm-scroller::-webkit-scrollbar-corner": {
      background: "transparent",
    },

    // ── Search matches ─────────────────────────────────────────────
    ".cm-searchMatch": {
      backgroundColor: "var(--surface-warning-weak)",
      outline: "1px solid var(--surface-warning-strong)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--surface-warning-base)",
    },

    // ── Search panel ───────────────────────────────────────────────
    ".cm-panel.cm-panel-search": {
      backgroundColor: "var(--surface-raised-base)",
      borderBottom: "1px solid var(--border-weak-base)",
      padding: "6px 8px",
      fontFamily: "var(--font-family-sans, sans-serif)",
      fontSize: "13px",
      color: "var(--text-strong)",
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
      alignItems: "center",
    },
    ".cm-panel.cm-panel-search label": {
      color: "var(--text-weak)",
      fontSize: "12px",
      display: "inline-flex",
      alignItems: "center",
      gap: "3px",
    },
    ".cm-panel.cm-panel-search input": {
      fontFamily: "var(--font-family-sans, sans-serif)",
      fontSize: "13px",
      backgroundColor: "var(--background-base)",
      color: "var(--text-strong)",
      border: "1px solid var(--border-weak-base)",
      borderRadius: "4px",
      padding: "2px 6px",
      outline: "none",
    },
    ".cm-panel.cm-panel-search input:focus": {
      borderColor: "var(--border-interactive-base)",
      boxShadow: "0 0 0 1px var(--border-interactive-base)",
    },
    ".cm-panel.cm-panel-search button": {
      fontFamily: "var(--font-family-sans, sans-serif)",
      fontSize: "12px",
      backgroundColor: "var(--surface-interactive-base)",
      color: "var(--text-on-interactive, #fff)",
      border: "none",
      borderRadius: "4px",
      padding: "3px 10px",
      cursor: "pointer",
    },
    ".cm-panel.cm-panel-search button:hover": {
      backgroundColor: "var(--surface-interactive-hover, var(--surface-interactive-base))",
    },
    ".cm-panel.cm-panel-search button[name=close]": {
      backgroundColor: "transparent",
      color: "var(--text-weak)",
      padding: "2px 6px",
      fontSize: "16px",
      lineHeight: "1",
    },
    ".cm-panel.cm-panel-search button[name=close]:hover": {
      color: "var(--text-strong)",
      backgroundColor: "var(--surface-base)",
    },

    // ── Tooltips (hover info, diagnostics) ─────────────────────────
    ".cm-tooltip": {
      backgroundColor: "var(--surface-raised-stronger-non-alpha)",
      border: "1px solid var(--border-weak-base)",
      borderRadius: "8px",
      boxShadow: "var(--shadow-md)",
      color: "var(--text-strong)",
      fontFamily: "var(--font-family-sans, sans-serif)",
      fontSize: "13px",
    },
    ".cm-tooltip .cm-tooltip-arrow:before": {
      borderTopColor: "var(--border-weak-base)",
    },
    ".cm-tooltip .cm-tooltip-arrow:after": {
      borderTopColor: "var(--surface-raised-base)",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li": {
        padding: "4px 8px",
      },
      "& > ul > li[aria-selected]": {
        backgroundColor: "var(--surface-interactive-base)",
        color: "var(--text-on-interactive, #fff)",
      },
    },

    // ── Special characters ─────────────────────────────────────────
    ".cm-specialChar": {
      color: "var(--text-warning, #e5a00d)",
      backgroundColor: "var(--surface-warning-weak)",
      borderRadius: "2px",
    },

    // ── Line wrapping (applied when lineWrapping compartment is enabled) ──
    ".cm-lineWrapping .cm-content": {
      flexWrap: "wrap",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
    },
  },
  { dark: false },
)
