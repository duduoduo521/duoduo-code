import { describe, expect, test } from "bun:test"
import * as ProviderIndex from "../../src/provider/index"

describe("provider/index exports", () => {
  test("exports Provider", () => {
    expect(ProviderIndex.Provider).toBeDefined()
  })

  test("exports ProviderAuth", () => {
    expect(ProviderIndex.ProviderAuth).toBeDefined()
  })

  test("exports ProviderError", () => {
    expect(ProviderIndex.ProviderError).toBeDefined()
  })

  test("exports ModelsDev", () => {
    expect(ProviderIndex.ModelsDev).toBeDefined()
  })

  test("exports ProviderTransform", () => {
    expect(ProviderIndex.ProviderTransform).toBeDefined()
  })
})
