import { describe, expect, test } from "bun:test"
import { activeEditorView, setActiveEditor, clearActiveEditorViewIf } from "./active-editor/index"

// Note: activeEditorView is a SolidJS signal. We need to test it inside createRoot.
import { createRoot } from "solid-js"

describe("activeEditorView signal", () => {
  test("initially returns undefined", () => {
    createRoot((dispose) => {
      expect(activeEditorView()).toBeUndefined()
      dispose()
    })
  })

  test("setActiveEditor sets the value", () => {
    createRoot((dispose) => {
      const mockView = {} as any
      setActiveEditor(mockView)
      expect(activeEditorView()).toBe(mockView)
      dispose()
    })
  })

  test("clearActiveEditorViewIf clears when view matches", () => {
    createRoot((dispose) => {
      const mockView = {} as any
      setActiveEditor(mockView)
      expect(activeEditorView()).toBe(mockView)

      clearActiveEditorViewIf(mockView)
      expect(activeEditorView()).toBeUndefined()
      dispose()
    })
  })

  test("clearActiveEditorViewIf does not clear when view doesn't match", () => {
    createRoot((dispose) => {
      const mockView1 = {} as any
      const mockView2 = {} as any
      setActiveEditor(mockView1)
      expect(activeEditorView()).toBe(mockView1)

      clearActiveEditorViewIf(mockView2)
      expect(activeEditorView()).toBe(mockView1)
      dispose()
    })
  })
})
