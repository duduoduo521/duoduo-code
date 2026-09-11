import type { PermissionRequest, QuestionRequest, Session } from "@duoduo-ai/sdk/v2/client"

function sessionTreeRequest<T>(
  session: Session[],
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return

  const map = session.reduce((acc, item) => {
    acc.set(item.id, item)
    return acc
  }, new Map<string, Session>())

  // Walk up the parent chain from sessionID
  const ids: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = sessionID
  while (current && !seen.has(current)) {
    seen.add(current)
    ids.push(current)
    current = map.get(current)?.parentID
  }

  const id = ids.find((id) => request[id]?.some(include))
  if (!id) return
  return request[id]?.find(include)
}

export function sessionPermissionRequest(
  session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

export function sessionQuestionRequest(
  session: Session[],
  request: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: QuestionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}
