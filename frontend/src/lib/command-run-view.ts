import type { CommandRun, CommandRunOrigin, CommandRunStatus } from '@/api/command-runs'

/**
 * UI 뷰모델. 서버 DTO(sessionId/messageId/commandName)와
 * 화면 코드(sessionID/messageID/name) 사이의 유일한 변환 지점.
 */
export interface CommandRunView {
  id: string
  sessionID: string
  name: string
  args: string
  startedAt: number
  messageID?: string
  directory?: string
  repoId?: number
  status: CommandRunStatus
  origin: CommandRunOrigin
}

export function toCommandRunView(run: CommandRun): CommandRunView {
  return {
    id: run.id,
    sessionID: run.sessionId,
    name: run.commandName,
    args: run.args ?? '',
    startedAt: run.startedAt,
    messageID: run.messageId ?? undefined,
    directory: run.directory ?? undefined,
    repoId: run.repoId ?? undefined,
    status: run.status,
    origin: run.origin,
  }
}

export function groupRunsBySession(runs: CommandRun[]): Record<string, CommandRunView[]> {
  const out: Record<string, CommandRunView[]> = {}
  for (const run of runs) {
    const view = toCommandRunView(run)
    if (!out[view.sessionID]) out[view.sessionID] = []
    out[view.sessionID].push(view)
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.startedAt - b.startedAt)
  }
  return out
}

/** 히스토리 패널용 트레일링 윈도우. 백엔드 범위 상한(1년) 안쪽으로 유지한다. */
export function historyWindow(days = 364): { start: Date; end: Date } {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - days)
  return { start, end }
}
