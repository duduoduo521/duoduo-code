import { describe, expect, test } from "bun:test"

// These functions are not exported, so we test them by extracting the logic
// into a testable form. The functions are: pruneNotifications, buildNotificationIndex

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

type NotificationBase = {
  directory?: string
  session?: string
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error: string
}

type Notification = TurnCompleteNotification | ErrorNotification

type NotificationIndex = {
  session: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function createNotificationIndex(): NotificationIndex {
  return {
    session: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
    project: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
  }
}

function buildNotificationIndex(list: Notification[]) {
  const index = createNotificationIndex()

  list.forEach((notification) => {
    if (notification.session) {
      const all = index.session.all[notification.session] ?? []
      index.session.all[notification.session] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.session.unseen[notification.session] ?? []
        index.session.unseen[notification.session] = [...unseen, notification]
        index.session.unseenCount[notification.session] = unseen.length + 1
        if (notification.type === "error") index.session.unseenHasError[notification.session] = true
      }
    }

    if (notification.directory) {
      const all = index.project.all[notification.directory] ?? []
      index.project.all[notification.directory] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.project.unseen[notification.directory] ?? []
        index.project.unseen[notification.directory] = [...unseen, notification]
        index.project.unseenCount[notification.directory] = unseen.length + 1
        if (notification.type === "error") index.project.unseenHasError[notification.directory] = true
      }
    }
  })

  return index
}

describe("pruneNotifications", () => {
  test("returns empty list for empty input", () => {
    expect(pruneNotifications([])).toEqual([])
  })

  test("keeps recent notifications", () => {
    const now = Date.now()
    const notifications: Notification[] = [
      { type: "turn-complete", session: "s1", time: now, viewed: false },
      { type: "turn-complete", session: "s2", time: now - 1000, viewed: true },
    ]
    const result = pruneNotifications(notifications)
    expect(result).toHaveLength(2)
  })

  test("removes notifications older than TTL", () => {
    const now = Date.now()
    const old = now - NOTIFICATION_TTL_MS - 1000
    const notifications: Notification[] = [
      { type: "turn-complete", session: "s1", time: old, viewed: false },
      { type: "turn-complete", session: "s2", time: now, viewed: false },
    ]
    const result = pruneNotifications(notifications)
    expect(result).toHaveLength(1)
    expect(result[0]!.session).toBe("s2")
  })

  test("keeps notifications at TTL boundary", () => {
    const now = Date.now()
    const atBoundary = now - NOTIFICATION_TTL_MS
    const notifications: Notification[] = [{ type: "turn-complete", session: "s1", time: atBoundary, viewed: false }]
    const result = pruneNotifications(notifications)
    expect(result).toHaveLength(1)
  })

  test("trims to MAX_NOTIFICATIONS when exceeded", () => {
    const now = Date.now()
    const notifications: Notification[] = Array.from({ length: 600 }, (_, i) => ({
      type: "turn-complete" as const,
      session: `s${i}`,
      time: now - i * 1000,
      viewed: false,
    }))
    const result = pruneNotifications(notifications)
    expect(result).toHaveLength(500)
    // Should keep the most recent ones (last 500 after TTL filter)
    // Since all are within TTL, slice keeps the last 500 entries
    expect(result[0]!.session).toBe("s100")
    expect(result[result.length - 1]!.session).toBe("s599")
  })
})

describe("buildNotificationIndex", () => {
  test("returns empty index for empty list", () => {
    const index = buildNotificationIndex([])
    expect(index.session.all).toEqual({})
    expect(index.session.unseen).toEqual({})
    expect(index.session.unseenCount).toEqual({})
    expect(index.session.unseenHasError).toEqual({})
    expect(index.project.all).toEqual({})
    expect(index.project.unseen).toEqual({})
    expect(index.project.unseenCount).toEqual({})
    expect(index.project.unseenHasError).toEqual({})
  })

  test("indexes session notifications", () => {
    const now = Date.now()
    const n1: Notification = { type: "turn-complete", session: "s1", time: now, viewed: false }
    const n2: Notification = { type: "turn-complete", session: "s1", time: now, viewed: true }
    const index = buildNotificationIndex([n1, n2])

    expect(index.session.all["s1"]!).toHaveLength(2)
    expect(index.session.unseen["s1"]!).toHaveLength(1)
    expect(index.session.unseen["s1"]![0]!).toBe(n1)
    expect(index.session.unseenCount["s1"]).toBe(1)
  })

  test("indexes project notifications", () => {
    const now = Date.now()
    const n1: Notification = {
      type: "turn-complete",
      session: "s1",
      directory: "/project",
      time: now,
      viewed: false,
    }
    const index = buildNotificationIndex([n1])

    expect(index.project.all["/project"]).toHaveLength(1)
    expect(index.project.unseen["/project"]).toHaveLength(1)
    expect(index.project.unseenCount["/project"]).toBe(1)
  })

  test("marks unseenHasError for error notifications", () => {
    const now = Date.now()
    const n1: Notification = {
      type: "error",
      session: "s1",
      directory: "/project",
      time: now,
      viewed: false,
      error: "Something went wrong",
    }
    const index = buildNotificationIndex([n1])

    expect(index.session.unseenHasError["s1"]).toBe(true)
    expect(index.project.unseenHasError["/project"]).toBe(true)
  })

  test("does not mark unseenHasError for turn-complete notifications", () => {
    const now = Date.now()
    const n1: Notification = {
      type: "turn-complete",
      session: "s1",
      directory: "/project",
      time: now,
      viewed: false,
    }
    const index = buildNotificationIndex([n1])

    expect(index.session.unseenHasError["s1"]).toBeUndefined()
    expect(index.project.unseenHasError["/project"]).toBeUndefined()
  })

  test("does not count viewed notifications as unseen", () => {
    const now = Date.now()
    const n1: Notification = {
      type: "turn-complete",
      session: "s1",
      directory: "/project",
      time: now,
      viewed: true,
    }
    const index = buildNotificationIndex([n1])

    expect(index.session.all["s1"]!).toHaveLength(1)
    expect(index.session.unseen["s1"]!).toBeUndefined()
    expect(index.session.unseenCount["s1"]).toBeUndefined()
    expect(index.project.unseen["/project"]).toBeUndefined()
  })

  test("handles notifications without session or directory", () => {
    const now = Date.now()
    const n1: Notification = { type: "turn-complete", time: now, viewed: false }
    const index = buildNotificationIndex([n1])

    expect(index.session.all).toEqual({})
    expect(index.project.all).toEqual({})
  })

  test("groups notifications by session and directory separately", () => {
    const now = Date.now()
    const n1: Notification = {
      type: "turn-complete",
      session: "s1",
      directory: "/project-a",
      time: now,
      viewed: false,
    }
    const n2: Notification = {
      type: "turn-complete",
      session: "s2",
      directory: "/project-a",
      time: now,
      viewed: false,
    }
    const index = buildNotificationIndex([n1, n2])

    expect(index.session.all["s1"]!).toHaveLength(1)
    expect(index.session.all["s2"]).toHaveLength(1)
    expect(index.project.all["/project-a"]).toHaveLength(2)
    expect(index.project.unseenCount["/project-a"]).toBe(2)
  })
})
