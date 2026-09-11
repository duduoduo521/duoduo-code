import { describe, expect, test } from "bun:test"
import * as Keybind from "../../src/util/keybind"

describe("util.keybind", () => {
  describe("match", () => {
    test("returns false when first arg is undefined", () => {
      expect(
        Keybind.match(undefined, { name: "a", ctrl: false, meta: false, shift: false, super: false, leader: false }),
      ).toBe(false)
    })

    test("matches identical info objects", () => {
      const info: Keybind.Info = { name: "a", ctrl: true, meta: false, shift: false, super: false, leader: false }
      expect(Keybind.match(info, info)).toBe(true)
    })

    test("does not match different keys", () => {
      const a: Keybind.Info = { name: "a", ctrl: true, meta: false, shift: false, super: false, leader: false }
      const b: Keybind.Info = { name: "b", ctrl: true, meta: false, shift: false, super: false, leader: false }
      expect(Keybind.match(a, b)).toBe(false)
    })

    test("normalizes undefined super to false", () => {
      const a: Keybind.Info = {
        name: "a",
        ctrl: false,
        meta: false,
        shift: false,
        super: undefined as any,
        leader: false,
      }
      const b: Keybind.Info = { name: "a", ctrl: false, meta: false, shift: false, super: false, leader: false }
      expect(Keybind.match(a, b)).toBe(true)
    })
  })

  describe("fromParsedKey", () => {
    test("converts space to 'space' name", () => {
      const info = Keybind.fromParsedKey({ name: " ", ctrl: false, meta: false, shift: false } as any)
      expect(info.name).toBe("space")
    })

    test("preserves other key names", () => {
      const info = Keybind.fromParsedKey({ name: "a", ctrl: true, meta: false, shift: false } as any)
      expect(info.name).toBe("a")
      expect(info.ctrl).toBe(true)
    })

    test("defaults super to false when undefined", () => {
      const info = Keybind.fromParsedKey({ name: "a", ctrl: false, meta: false, shift: false, super: undefined } as any)
      expect(info.super).toBe(false)
    })

    test("defaults leader to false", () => {
      const info = Keybind.fromParsedKey({ name: "a", ctrl: false, meta: false, shift: false } as any)
      expect(info.leader).toBe(false)
    })

    test("accepts leader parameter", () => {
      const info = Keybind.fromParsedKey({ name: "a", ctrl: false, meta: false, shift: false } as any, true)
      expect(info.leader).toBe(true)
    })
  })

  describe("toString", () => {
    test("returns empty string for undefined", () => {
      expect(Keybind.toString(undefined)).toBe("")
    })

    test("formats simple key", () => {
      expect(Keybind.toString({ name: "a", ctrl: false, meta: false, shift: false, super: false, leader: false })).toBe(
        "a",
      )
    })

    test("formats ctrl+key", () => {
      expect(Keybind.toString({ name: "a", ctrl: true, meta: false, shift: false, super: false, leader: false })).toBe(
        "ctrl+a",
      )
    })

    test("formats ctrl+alt+key", () => {
      expect(Keybind.toString({ name: "a", ctrl: true, meta: true, shift: false, super: false, leader: false })).toBe(
        "ctrl+alt+a",
      )
    })

    test("formats shift+key", () => {
      expect(Keybind.toString({ name: "a", ctrl: false, meta: false, shift: true, super: false, leader: false })).toBe(
        "shift+a",
      )
    })

    test("maps delete to del", () => {
      expect(
        Keybind.toString({ name: "delete", ctrl: false, meta: false, shift: false, super: false, leader: false }),
      ).toBe("del")
    })

    test("formats leader key", () => {
      expect(Keybind.toString({ name: "a", ctrl: false, meta: false, shift: false, super: false, leader: true })).toBe(
        "<leader> a",
      )
    })

    test("formats leader without key name", () => {
      expect(Keybind.toString({ name: "", ctrl: false, meta: false, shift: false, super: false, leader: true })).toBe(
        "<leader>",
      )
    })
  })

  describe("parse", () => {
    test('returns empty array for "none"', () => {
      expect(Keybind.parse("none")).toEqual([])
    })

    test("parses simple key", () => {
      const result = Keybind.parse("a")
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("a")
      expect(result[0].ctrl).toBe(false)
      expect(result[0].meta).toBe(false)
      expect(result[0].shift).toBe(false)
      expect(result[0].leader).toBe(false)
    })

    test("parses ctrl+key", () => {
      const result = Keybind.parse("ctrl+a")
      expect(result[0].ctrl).toBe(true)
      expect(result[0].name).toBe("a")
    })

    test("parses alt as meta", () => {
      const result = Keybind.parse("alt+a")
      expect(result[0].meta).toBe(true)
    })

    test("parses meta as meta", () => {
      const result = Keybind.parse("meta+a")
      expect(result[0].meta).toBe(true)
    })

    test("parses option as meta", () => {
      const result = Keybind.parse("option+a")
      expect(result[0].meta).toBe(true)
    })

    test("parses shift+key", () => {
      const result = Keybind.parse("shift+a")
      expect(result[0].shift).toBe(true)
    })

    test("parses super+key", () => {
      const result = Keybind.parse("super+a")
      expect(result[0].super).toBe(true)
    })

    test("parses leader key", () => {
      const result = Keybind.parse("<leader>a")
      expect(result[0].leader).toBe(true)
      expect(result[0].name).toBe("a")
    })

    test("maps esc to escape", () => {
      const result = Keybind.parse("esc")
      expect(result[0].name).toBe("escape")
    })

    test("parses comma-separated combos", () => {
      const result = Keybind.parse("ctrl+a,ctrl+b")
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe("a")
      expect(result[1].name).toBe("b")
    })

    test("is case-insensitive", () => {
      const result = Keybind.parse("Ctrl+A")
      expect(result[0].ctrl).toBe(true)
      expect(result[0].name).toBe("a")
    })
  })
})
