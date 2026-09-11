import { describe, expect, test } from "bun:test"
import * as StorageIndex from "../../src/storage/index"

describe("storage.index", () => {
  test("exports JsonMigration namespace", () => {
    expect(StorageIndex.JsonMigration).toBeDefined()
  })

  test("exports Database namespace", () => {
    expect(StorageIndex.Database).toBeDefined()
  })

  test("exports Storage namespace", () => {
    expect(StorageIndex.Storage).toBeDefined()
  })

  test("exports drizzle-orm operators", () => {
    expect(typeof StorageIndex.eq).toBe("function")
    expect(typeof StorageIndex.and).toBe("function")
    expect(typeof StorageIndex.or).toBe("function")
    expect(typeof StorageIndex.desc).toBe("function")
    expect(typeof StorageIndex.asc).toBe("function")
    expect(typeof StorageIndex.not).toBe("function")
    expect(typeof StorageIndex.sql).toBe("function")
    expect(typeof StorageIndex.inArray).toBe("function")
    expect(typeof StorageIndex.isNull).toBe("function")
    expect(typeof StorageIndex.isNotNull).toBe("function")
    expect(typeof StorageIndex.count).toBe("function")
    expect(typeof StorageIndex.like).toBe("function")
    expect(typeof StorageIndex.exists).toBe("function")
    expect(typeof StorageIndex.between).toBe("function")
    expect(typeof StorageIndex.gt).toBe("function")
    expect(typeof StorageIndex.gte).toBe("function")
    expect(typeof StorageIndex.lt).toBe("function")
    expect(typeof StorageIndex.lte).toBe("function")
    expect(typeof StorageIndex.ne).toBe("function")
  })

  test("exports NotFoundError", () => {
    expect(StorageIndex.NotFoundError).toBeDefined()
  })
})
