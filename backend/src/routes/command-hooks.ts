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

// 세션별 idle 스캔 워터마크 — 마지막으로 본 assistant 생성시각 + 스캔 시각.
// 1시간 넘게 조용하면 버린다 (재시작 리셋과 동등 — messageId dup이 중복 기록을 막는다).
const idleWatermarks = new Map<string, { created: number; at: number }>()
const WATERMARK_TTL_MS = 3_600_000

/** 이력 저장용 인자 정제 — recall 블록·TODO 프로토콜을 벗기고 2000자로 자른다. */
function cleanArgsForHistory(args: string): string | null {
  let t = (args ?? '').replace(/<memory-recall>[\s\S]*?<\/memory-recall>\s*/gi, '')
  const protoIdx = t.indexOf('[execution-protocol]')
  if (protoIdx >= 0) t = t.slice(0, protoIdx)
  t = t.trim()
  if (!t) return null
  return t.length > 2000 ? `${t.slice(0, 2000)}…` : t
}

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
 * command.executed — 큐·스케줄러가 먼저 기록한 run이 있으면 messageId를 붙이고,
 * 없으면 외부 실행(TUI 등)으로 새로 기록한다. 외부 실행은 세션 토글이 없으므로
 * 두 플래그를 명시 false로 박는다 (생략하면 레포 설정으로 새어나간다).
 */
async function handleCommandExecuted(
  db: Database,
  sessionID: string,
  name: string,
  args: string,
  messageID: string | undefined,
): Promise<void> {
  if (!name) return
  const outcome = await fetchMessageOutcome(sessionID, messageID)
  const { listRunsBySession, attachMessage } = await import('../services/command-runs')
  try {
    const runs = await listRunsBySession(db, sessionID)
    const msgCreated = outcome?.created ?? 0
    const candidates = runs
      .filter((r) => r.commandName === name && Date.now() - r.startedAt < 600_000)
      .sort((a, b) => b.startedAt - a.startedAt)
    for (const run of candidates.slice(0, 5)) {
      // 메시지 시각을 알면 엄격 상관, 모르면 최신 started/finished-<30s 휴리스틱
      if (outcome) {
        if (msgCreated < run.startedAt - 10_000) continue
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
  // 상관 실패 = 외부 실행: 명시 false로 기록하고 턴 결과로 finish (리뷰 스폰 없음).
  const directory = await fetchSessionDirectory(sessionID)
  const { resolveCommandKind } = await import('../services/command-hooks')
  const { recordRunStartSafe, resolveRepoId, finishRunSafe } = await import('../services/command-runs')
  const kind = resolveCommandKind(directory, name)
  const run = await recordRunStartSafe(db, {
    sessionId: sessionID,
    commandName: name,
    args: cleanArgsForHistory(args),
    directory,
    repoId: directory ? resolveRepoId(db, directory) : null,
    origin: 'external',
    kind,
    reviewWanted: false,
    autoApply: false,
  })
  if (!run) return
  if (messageID) {
    try {
      const { attachMessage } = await import('../services/command-runs')
      await attachMessage(db, run.id, messageID)
    } catch {}
  }
  logger.info(`Hook external command /${name} recorded (explicit flags false) for session ${sessionID}`)
  if (outcome?.failed) logger.warn(`Hook command /${name} turn errored — marking failed`)
  await finishRunSafe(db, run.id, outcome?.failed ? 'failed' : 'completed')
}

/**
 * session.idle — 모델이 알아서 쓴 skill tool 호출을 소급 기록한다 (origin 'auto').
 * 리뷰 스폰은 커맨드만 하므로(정책) skill은 이력 + skill-check까지만 연결된다.
 */
async function handleSessionIdle(db: Database, sessionID: string): Promise<void> {
  const now = Date.now()
  // TTL 만료 워터마크 정리 (전체 clear가 아니라 만료분만)
  if (idleWatermarks.size > 2000) {
    for (const [k, v] of idleWatermarks) {
      if (now - v.at > WATERMARK_TTL_MS) idleWatermarks.delete(k)
    }
  }
  const watermark = idleWatermarks.get(sessionID)?.created ?? 0
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
  idleWatermarks.set(sessionID, { created: maxSeen, at: now })
  if (fresh.length === 0) return

  const directory = await fetchSessionDirectory(sessionID)
  const { resolveCommandKind } = await import('../services/command-hooks')
  const { recordRunStartSafe, resolveRepoId, finishRunSafe, attachMessage, listRunsBySession } = await import('../services/command-runs')
  // 중복 판정: 같은 messageId면 스킵, 큐가 먼저 만든 행이면 붙이고, 둘 다 아니면 새로 만든다.
  // messageId 키가 재시작 후에도 안전하고, 시간 상관은 큐 행에만 쓴다.
  let sessionRuns: Awaited<ReturnType<typeof listRunsBySession>>
  try {
    sessionRuns = await listRunsBySession(db, sessionID)
  } catch {
    sessionRuns = []
  }
  const recordedKeys = new Set(
    sessionRuns.flatMap((r) => (r.messageId ? [`${r.commandName}\n${r.messageId}`] : [])),
  )
  for (const m of fresh) {
    const msgId = (m.info as { id?: string } | undefined)?.id
    const msgCreated = (m.info as { time?: { created?: number } } | undefined)?.time?.created ?? 0
    const parts = (m as { parts?: Array<Record<string, unknown>> }).parts ?? []
    for (const p of parts) {
      if (p?.type !== 'tool' || (p as { tool?: string }).tool !== 'skill') continue
      const state = (p as { state?: { status?: string; input?: { name?: string } } }).state
      const skillName = state?.input?.name
      if (!skillName) continue
      const dedupKey = `${skillName}\n${msgId ?? ''}`
      if (recordedKeys.has(dedupKey)) continue
      // 큐가 먼저 만든 행(아직 messageId 없음)에 붙인다.
      // messageId 있는 행은 완성된 기록이라 건드리지 않는다 (새 턴이면 아래서 새로 만든다).
      // 1시간 넘은 started 행(stuck)은 다른 턴 것으로 보고 제외한다.
      const queued = sessionRuns
        .filter((r) => r.commandName === skillName && !r.messageId && Date.now() - r.startedAt < 3_600_000)
        .sort((a, b) => b.startedAt - a.startedAt)[0]
      if (queued && (!msgCreated || msgCreated >= queued.startedAt - 10_000)) {
        if (msgId) {
          try {
            await attachMessage(db, queued.id, msgId)
          } catch {}
          recordedKeys.add(dedupKey)
        }
        continue
      }
      // 모델 주도 실행: 명시 false로 기록 (세션 토글 없음 → 상속 금지)
      const run = await recordRunStartSafe(db, {
        sessionId: sessionID,
        commandName: skillName,
        args: null,
        directory,
        repoId: directory ? resolveRepoId(db, directory) : null,
        origin: 'auto',
        kind: resolveCommandKind(directory, skillName),
        reviewWanted: false,
        autoApply: false,
      })
      if (!run) continue
      if (msgId) {
        try {
          await attachMessage(db, run.id, msgId)
        } catch {}
        recordedKeys.add(dedupKey)
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
