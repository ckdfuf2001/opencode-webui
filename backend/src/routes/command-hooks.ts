import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import { recentSessionMessages } from '../services/session-message-db'

const HookEventSchema = z.object({
  type: z.enum(['plugin.ready', 'command.executed', 'session.idle']),
  sessionID: z.string().min(1).max(200).optional(),
  name: z.string().max(200).optional(),
  args: z.string().max(20000).optional(),
  messageID: z.string().max(200).optional(),
})

// 세션별 idle 스캔 워터마크 — 마지막으로 본 assistant 생성시각. 메모리만 쓴다.
const idleWatermarks = new Map<string, number>()
const RECENT_RUN_WINDOW_MS = 300_000

async function fetchSessionDirectory(sessionID: string): Promise<string | undefined> {
  try {
    const { opencodeServerManager } = await import('../services/opencode-single-server')
    const { ensureServerAuth } = await import('../services/opencode-auth')
    const base = opencodeServerManager.getUrl()
    const res = await fetch(`${base}/session/${encodeURIComponent(sessionID)}`, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return undefined
    const info = (await res.json()) as { directory?: string }
    return typeof info?.directory === 'string' && info.directory ? info.directory : undefined
  } catch {
    return undefined
  }
}

/** 지정 메시지의 생성시각 + 에러 여부. 조회 실패·없음이면 null (fail-open). */
async function fetchMessageOutcome(
  sessionID: string,
  messageID: string | undefined,
): Promise<{ created: number; failed: boolean } | null> {
  if (!messageID) return null
  try {
    const tail = await recentSessionMessages(sessionID, 10)
    const hit = (tail?.messages ?? []).find(
      (m) => (m.info as { id?: string })?.id === messageID,
    )
    if (!hit) return null
    const info = hit.info as { time?: { created?: number }; error?: { name?: string } }
    const err = info?.error
    return {
      created: info?.time?.created ?? 0,
      failed: !!err && err.name !== 'MessageAbortedError',
    }
  } catch {
    return null
  }
}

/**
 * command.executed — /command로 실행된 모든 커맨드(TUI·API·큐)를 한 곳에서 마무리한다.
 * 중복 방지는 messageID 생성시각 상관으로 한다: 이벤트 메시지가 run 시작 이후에
 * 만들어졌을 때만 같은 실행으로 본다. 인자 문자열은 recall/프로토콜이 덧붙어
 * 정확히 안 맞으므로 키로 쓰지 않는다.
 */
async function handleCommandExecuted(
  db: Database,
  sessionID: string,
  name: string,
  args: string,
  messageID: string | undefined,
): Promise<void> {
  if (!name) return
  const { listRunsBySession, attachMessage } = await import('../services/command-runs')
  const outcome = await fetchMessageOutcome(sessionID, messageID)
  try {
    const runs = await listRunsBySession(db, sessionID)
    const candidates = runs
      .filter((r) => r.commandName === name && Date.now() - r.startedAt < 600_000)
      .sort((a, b) => b.startedAt - a.startedAt)
    for (const run of candidates.slice(0, 5)) {
      // 메시지 시각을 알면 엄격 상관, 모르면 최신 started/finished-<30s 휴리스틱
      if (outcome) {
        if (outcome.created < run.startedAt - 10_000) continue
      } else if (run.status !== 'started' && Date.now() - (run.finishedAt ?? 0) > 30_000) {
        continue
      }
      if (messageID) {
        try {
          await attachMessage(db, run.id, messageID)
        } catch (e) {
          logger.debug('Hook attach skipped:', e)
        }
      }
      if (run.status === 'started') {
        const { finishRunSafe } = await import('../services/command-runs')
        if (outcome?.failed) logger.warn(`Hook command /${name} turn errored — marking failed`)
        await finishRunSafe(db, run.id, outcome?.failed ? 'failed' : 'completed')
      }
      logger.debug(`Hook command.executed correlated to run ${run.id} (/${name})`)
      return
    }
  } catch (e) {
    logger.debug('Hook correlation skipped:', e)
  }
  // 상관 실패 = 진짜 새 실행(TUI 등): 새로 기록하고 턴 결과로 finish.
  // 큐 발송분이면 남겨둔 스냅샷(세션 오버라이드)을 싣는다.
  const directory = await fetchSessionDirectory(sessionID)
  const { resolveCommandKind, peekDispatchContext } = await import('../services/command-hooks')
  const { recordRunStartSafe, resolveRepoId, finishRunSafe } = await import('../services/command-runs')
  const kind = resolveCommandKind(directory, name)
  const snap = peekDispatchContext(sessionID, name)
  const run = await recordRunStartSafe(db, {
    sessionId: sessionID,
    commandName: name,
    args: args.trim() || null,
    directory,
    repoId: directory ? resolveRepoId(db, directory) : null,
    origin: snap?.origin ?? 'ui',
    kind,
    ...(snap?.reviewWanted !== undefined ? { reviewWanted: snap.reviewWanted } : {}),
    ...(snap?.autoApply !== undefined ? { autoApply: snap.autoApply } : {}),
  })
  if (!run) return
  if (messageID) {
    try {
      await attachMessage(db, run.id, messageID)
    } catch {}
  }
  if (outcome?.failed) logger.warn(`Hook command /${name} turn errored — marking failed`)
  await finishRunSafe(db, run.id, outcome?.failed ? 'failed' : 'completed')
}

/**
 * session.idle — 모델이 알아서 쓴 skill tool 호출을 소급 기록한다 (origin 'auto').
 * 리뷰 스폰은 커맨드만 하므로(정책) skill은 이력 + skill-check까지만 연결된다.
 */
async function handleSessionIdle(db: Database, sessionID: string): Promise<void> {
  let watermark = idleWatermarks.get(sessionID) ?? 0
  if (idleWatermarks.size > 2000) idleWatermarks.clear()
  let tail: Awaited<ReturnType<typeof recentSessionMessages>>
  try {
    tail = await recentSessionMessages(sessionID, 20)
  } catch {
    return
  }
  const msgs = tail?.messages ?? []
  let maxSeen = watermark
  const fresh: typeof msgs = []
  for (const m of msgs) {
    const info = m.info as { role?: string; time?: { created?: number }; id?: string } | undefined
    const created = info?.time?.created ?? 0
    if (created > maxSeen) maxSeen = created
    if (info?.role === 'assistant' && created > watermark) fresh.push(m)
  }
  idleWatermarks.set(sessionID, maxSeen)
  if (fresh.length === 0) return

  const directory = await fetchSessionDirectory(sessionID)
  const { resolveCommandKind, peekDispatchContext } = await import('../services/command-hooks')
  const { recordRunStartSafe, resolveRepoId, finishRunSafe, attachMessage } = await import('../services/command-runs')
  for (const m of fresh) {
    const parts = (m as { parts?: Array<Record<string, unknown>> }).parts ?? []
    for (const p of parts) {
      if (p?.type !== 'tool' || (p as { tool?: string }).tool !== 'skill') continue
      const state = (p as { state?: { status?: string; input?: { name?: string } } }).state
      const skillName = state?.input?.name
      if (!skillName) continue
      // 큐·외부 기록과 중복 방지 (300초 윈도우)
      let dup = false
      try {
        const { listRunsBySession } = await import('../services/command-runs')
        const runs = await listRunsBySession(db, sessionID)
        const now = Date.now()
        dup = runs.some((r) => r.commandName === skillName && now - r.startedAt < RECENT_RUN_WINDOW_MS)
      } catch {}
      if (dup) continue
      const msgId = (m.info as { id?: string } | undefined)?.id
      const snap = peekDispatchContext(sessionID, skillName)
      const run = await recordRunStartSafe(db, {
        sessionId: sessionID,
        commandName: skillName,
        args: null,
        directory,
        repoId: directory ? resolveRepoId(db, directory) : null,
        origin: snap?.origin ?? 'auto',
        kind: resolveCommandKind(directory, skillName),
        ...(snap?.reviewWanted !== undefined ? { reviewWanted: snap.reviewWanted } : {}),
        ...(snap?.autoApply !== undefined ? { autoApply: snap.autoApply } : {}),
      })
      if (!run) continue
      if (msgId) {
        try {
          await attachMessage(db, run.id, msgId)
        } catch {}
      }
      const failed = state?.status === 'error'
      logger.info(`Hook auto skill /${skillName} recorded (${failed ? 'failed' : 'completed'}) for session ${sessionID}`)
      await finishRunSafe(db, run.id, failed ? 'failed' : 'completed')
    }
  }
}

export function createCommandHooksRoutes(db: Database) {
  const app = new Hono()

  // POST /api/command-hooks/event — opencode 후크 플러그인 콜백 (관측 전용).
  // 실패해도 200을 돌려준다. 에이전트 실행에 절대 영향을 주지 않는다.
  app.post('/event', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }
    const parsed = HookEventSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Invalid event' }, 400)
    const ev = parsed.data
    try {
      if (ev.type === 'plugin.ready') {
        logger.info('WebUI hooks plugin loaded by opencode server')
      } else if (!ev.sessionID) {
        return c.json({ error: 'sessionID required' }, 400)
      } else if (ev.type === 'command.executed') {
        await handleCommandExecuted(db, ev.sessionID, (ev.name ?? '').trim(), ev.args ?? '', ev.messageID)
      } else {
        await handleSessionIdle(db, ev.sessionID)
      }
      return c.json({ ok: true })
    } catch (e) {
      logger.warn('Hook event handling skipped:', e)
      return c.json({ ok: true })
    }
  })

  return app
}
