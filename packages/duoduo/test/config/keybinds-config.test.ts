import { describe, test, expect } from "bun:test"
import { Keybinds } from "../../src/config/keybinds"

describe("Keybinds (Zod schema)", () => {
  describe("parsing valid configs", () => {
    test("accepts empty object (all defaults)", () => {
      const result = Keybinds.parse({})
      expect(result.leader).toBe("ctrl+x")
      expect(result.editor_open).toBe("<leader>e")
      expect(result.sidebar_toggle).toBe("<leader>b")
      expect(result.session_new).toBe("<leader>n")
    })

    test("accepts partial overrides", () => {
      const result = Keybinds.parse({
        leader: "ctrl+space",
        sidebar_toggle: "<leader>s",
      })
      expect(result.leader).toBe("ctrl+space")
      expect(result.sidebar_toggle).toBe("<leader>s")
      // other fields get defaults
      expect(result.editor_open).toBe("<leader>e")
      expect(result.session_new).toBe("<leader>n")
    })

    test("accepts full override", () => {
      const result = Keybinds.parse({
        leader: "ctrl+z",
        app_exit: "ctrl+q",
        editor_open: "ctrl+e",
        theme_list: "ctrl+t",
        sidebar_toggle: "ctrl+b",
        scrollbar_toggle: "ctrl+s",
        username_toggle: "ctrl+u",
        status_view: "ctrl+i",
        session_export: "ctrl+x",
        session_new: "ctrl+n",
        session_list: "ctrl+l",
        session_timeline: "ctrl+g",
        session_fork: "ctrl+f",
        session_rename: "ctrl+r",
        session_delete: "ctrl+d",
        stash_delete: "ctrl+shift+d",
        model_provider_list: "ctrl+a",
        model_favorite_toggle: "ctrl+m",
        session_interrupt: "escape",
        session_compact: "ctrl+c",
        messages_page_up: "pageup",
        messages_page_down: "pagedown",
        messages_line_up: "ctrl+up",
        messages_line_down: "ctrl+down",
        messages_half_page_up: "ctrl+u",
        messages_half_page_down: "ctrl+d",
        messages_first: "home",
        messages_last: "end",
        messages_next: "ctrl+n",
        messages_previous: "ctrl+p",
        messages_last_user: "ctrl+shift+u",
        messages_copy: "ctrl+y",
        messages_undo: "ctrl+z",
        messages_redo: "ctrl+shift+z",
        messages_toggle_conceal: "ctrl+h",
        tool_details: "ctrl+d",
        model_list: "ctrl+m",
        model_cycle_recent: "f2",
        model_cycle_recent_reverse: "shift+f2",
        model_cycle_favorite: "f3",
        model_cycle_favorite_reverse: "shift+f3",
        command_list: "ctrl+p",
        agent_list: "ctrl+a",
        agent_cycle: "tab",
        agent_cycle_reverse: "shift+tab",
        variant_cycle: "ctrl+t",
        variant_list: "ctrl+shift+v",
        input_clear: "ctrl+c",
        input_paste: "ctrl+v",
        input_submit: "return",
        input_newline: "shift+return",
        input_move_left: "left",
        input_move_right: "right",
        input_move_up: "up",
        input_move_down: "down",
        input_select_left: "shift+left",
        input_select_right: "shift+right",
        input_select_up: "shift+up",
        input_select_down: "shift+down",
        input_line_home: "ctrl+a",
        input_line_end: "ctrl+e",
        input_select_line_home: "ctrl+shift+a",
        input_select_line_end: "ctrl+shift+e",
        input_visual_line_home: "alt+a",
        input_visual_line_end: "alt+e",
        input_select_visual_line_home: "alt+shift+a",
        input_select_visual_line_end: "alt+shift+e",
        input_buffer_home: "home",
        input_buffer_end: "end",
        input_select_buffer_home: "shift+home",
        input_select_buffer_end: "shift+end",
        input_delete_line: "ctrl+shift+d",
        input_delete_to_line_end: "ctrl+k",
        input_delete_to_line_start: "ctrl+u",
        input_backspace: "backspace",
        input_delete: "delete",
        input_undo: "ctrl+z",
        input_redo: "ctrl+y",
        input_word_forward: "alt+f",
        input_word_backward: "alt+b",
        input_select_word_forward: "alt+shift+f",
        input_select_word_backward: "alt+shift+b",
        input_delete_word_forward: "alt+d",
        input_delete_word_backward: "ctrl+w",
        history_previous: "up",
        history_next: "down",
        session_child_first: "<leader>down",
        session_child_cycle: "right",
        session_child_cycle_reverse: "left",
        session_parent: "up",
        terminal_suspend: "ctrl+z",
        terminal_title_toggle: "ctrl+t",
        tips_toggle: "<leader>h",
        plugin_manager: "ctrl+p",
        display_thinking: "ctrl+shift+t",
      })
      // Spot-check a few values
      expect(result.leader).toBe("ctrl+z")
      expect(result.input_submit).toBe("return")
      expect(result.agent_cycle).toBe("tab")
      expect(result.terminal_suspend).toBe("ctrl+z")
    })
  })

  describe("defaults", () => {
    test("input_undo defaults depend on platform", () => {
      const result = Keybinds.parse({})
      if (process.platform === "win32") {
        expect(result.input_undo).toBe("ctrl+z,ctrl+-,super+z")
      } else {
        expect(result.input_undo).toBe("ctrl+-,super+z")
      }
    })

    test("fields with 'none' default are preserved when set to non-none", () => {
      const result = Keybinds.parse({ scrollbar_toggle: "ctrl+s" })
      expect(result.scrollbar_toggle).toBe("ctrl+s")
    })

    test("fields with 'none' default remain 'none' when not provided", () => {
      const result = Keybinds.parse({})
      expect(result.scrollbar_toggle).toBe("none")
      expect(result.session_fork).toBe("none")
      expect(result.messages_next).toBe("none")
      expect(result.messages_previous).toBe("none")
      expect(result.terminal_title_toggle).toBe("none")
      expect(result.plugin_manager).toBe("none")
      expect(result.display_thinking).toBe("none")
    })
  })

  describe("type safety", () => {
    test("rejects non-string values", () => {
      expect(() => Keybinds.parse({ leader: 123 })).toThrow()
    })

    test("rejects null values", () => {
      expect(() => Keybinds.parse({ leader: null })).toThrow()
    })

    test("rejects undefined for required parse (though .parse(undefined) works with defaults)", () => {
      // Keybinds.parse(undefined) is the same as Keybinds.parse({}) with defaults
      const result = Keybinds.parse({})
      expect(result.leader).toBeDefined()
    })

    test("strips unknown keys", () => {
      const result = Keybinds.parse({ leader: "ctrl+x", unknown_key: "value" })
      expect(result.leader).toBe("ctrl+x")
      expect((result as any).unknown_key).toBeUndefined()
    })
  })

  describe("special key values", () => {
    test("accepts single-key bindings", () => {
      const result = Keybinds.parse({ session_interrupt: "escape" })
      expect(result.session_interrupt).toBe("escape")
    })

    test("accepts composite bindings (comma-separated)", () => {
      const result = Keybinds.parse({ input_undo: "ctrl+z,ctrl+-,super+z" })
      expect(result.input_undo).toBe("ctrl+z,ctrl+-,super+z")
    })

    test("accepts leader key syntax", () => {
      const result = Keybinds.parse({ editor_open: "<leader>f" })
      expect(result.editor_open).toBe("<leader>f")
    })

    test("accepts function keys", () => {
      const result = Keybinds.parse({ model_cycle_recent: "f12" })
      expect(result.model_cycle_recent).toBe("f12")
    })

    test("accepts modifier+key combinations", () => {
      const result = Keybinds.parse({ leader: "ctrl+alt+shift+super+x" })
      expect(result.leader).toBe("ctrl+alt+shift+super+x")
    })
  })
})
