import {
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  keymap,
  rectangularSelection,
  highlightSpecialChars,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
} from "@codemirror/language"
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { Compartment, type Extension } from "@codemirror/state"
import { codeMirrorTheme } from "./theme"
import { secondarySelection } from "./secondary-selection"

export const closeBracketsCompartment = new Compartment()
export const bracketMatchingCompartment = new Compartment()
export const indentOnInputCompartment = new Compartment()
export const highlightSpecialCharsCompartment = new Compartment()
export const closeBracketsKeymapCompartment = new Compartment()

/**
 * Base extensions for the CodeMirror editor.
 * These are always loaded regardless of file type.
 *
 * Does NOT include language-specific extensions — those are loaded
 * lazily via `resolveLanguageExtension()` in languages.ts.
 *
 * Does NOT include compartment-based extensions (readOnly, tabSize,
 * lineWrapping) — those are configured in the editor component.
 */
export function createBaseExtensions(): Extension[] {
  return [
    // Theme (CSS variable-based, follows app theme)
    codeMirrorTheme,

    // Line numbers
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),

    // Selection: rely on the browser's native ::selection / caret for the
    // PRIMARY range — same UX as <textarea> / VSCode (zero frame lag, no
    // off-by-N highlight bugs). The `secondarySelection` layer below restores
    // visualization for non-primary ranges (multi-cursor, Alt+drag rectangle).
    secondarySelection,
    bracketMatchingCompartment.of(bracketMatching()),

    // Auto-close brackets (typing `(` inserts `)` etc.)
    // Wrapped in a Compartment so it can be disabled during IME composition
    closeBracketsCompartment.of(closeBrackets()),

    // Rectangular selection (Alt+drag)
    rectangularSelection(),

    // Highlight special / invisible characters
    highlightSpecialCharsCompartment.of(highlightSpecialChars()),

    // Indentation
    indentOnInputCompartment.of(indentOnInput()),

    // History (undo/redo)
    history(),

    // Code folding gutter
    foldGutter(),

    // Syntax highlighting fallback (uses default tags when no language ext)
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

    // Key bindings (closeBracketsKeymap before defaultKeymap so Backspace
    // deletes bracket pairs and Enter handles bracket-aware newlines)
    closeBracketsKeymapCompartment.of(keymap.of([...closeBracketsKeymap])),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  ]
}
