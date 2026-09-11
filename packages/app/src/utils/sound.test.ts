import { describe, expect, test, mock, beforeAll } from "bun:test"
import { SOUND_OPTIONS, playSound } from "./sound"

describe("SOUND_OPTIONS", () => {
  test("has expected sound categories", () => {
    const categories = new Set(SOUND_OPTIONS.map((o) => o.id.split("-")[0]!))
    expect(categories.has("alert")).toBe(true)
    expect(categories.has("bip")).toBe(true)
    expect(categories.has("staplebops")).toBe(true)
    expect(categories.has("nope")).toBe(true)
    expect(categories.has("yup")).toBe(true)
  })

  test("each option has id and label", () => {
    for (const option of SOUND_OPTIONS) {
      expect(option.id).toBeTruthy()
      expect(option.label).toBeTruthy()
    }
  })

  test("all ids are unique", () => {
    const ids = SOUND_OPTIONS.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("labels follow i18n key pattern", () => {
    for (const option of SOUND_OPTIONS) {
      expect(option.label).toMatch(/^sound\.option\./)
    }
  })

  test("has correct count of sound options", () => {
    // alert: 10, bip-bop: 10, staplebops: 7, nope: 12, yup: 6 = 45
    expect(SOUND_OPTIONS.length).toBe(45)
  })

  test("ids match the pattern category-NN (allowing hyphens in category)", () => {
    for (const option of SOUND_OPTIONS) {
      expect(option.id).toMatch(/^[a-z][a-z-]*-\d+$/)
    }
  })
})

describe("playSound", () => {
  let audioInstances: { src: string; played: boolean; paused: boolean; currentTime: number }[] = []

  beforeAll(() => {
    // Mock Audio constructor
    const OriginalAudio = globalThis.Audio
    // @ts-expect-error mocking Audio
    globalThis.Audio = mock(function (this: any, src: string) {
      const instance = { src, played: false, paused: false, currentTime: 0 }
      audioInstances.push(instance)
      return {
        src,
        play: mock(() => {
          instance.played = true
          return Promise.resolve()
        }),
        pause: mock(() => {
          instance.paused = true
        }),
        get currentTime() {
          return instance.currentTime
        },
        set currentTime(v: number) {
          instance.currentTime = v
        },
      }
    })
  })

  test("creates Audio with given src and calls play", () => {
    audioInstances = []
    const stop = playSound("test-audio-src")
    expect(audioInstances.length).toBe(1)
    expect(audioInstances[0]!.src).toBe("test-audio-src")
    expect(audioInstances[0]!.played).toBe(true)
  })

  test("returns a stop function that pauses and resets audio", () => {
    audioInstances = []
    const stop = playSound("test-stop-src")
    expect(stop).toBeDefined()
    stop!()
    expect(audioInstances[0]!.paused).toBe(true)
    expect(audioInstances[0]!.currentTime).toBe(0)
  })

  test("returns undefined when src is undefined", () => {
    const result = playSound(undefined)
    expect(result).toBeUndefined()
  })

  test("returns undefined when src is empty string", () => {
    const result = playSound("")
    expect(result).toBeUndefined()
  })
})

// soundSrc and playSoundById depend on import.meta.glob which is unavailable in test.
// We test the pure logic portions (SOUND_OPTIONS, playSound) that can be verified
// without file-system loading.
//
// soundSrc logic recap (for documentation):
//   1. getLoads() resolves audio file lazy-loaders via import.meta.glob
//   2. if !id or id not in loads → Promise.resolve(undefined)
//   3. otherwise loads, caches, and returns the audio URL string
//
// playSoundById logic recap:
//   1. soundSrc(id).then(src => playSound(src))
//   2. For empty/undefined id → soundSrc returns undefined → playSound(undefined) → undefined
