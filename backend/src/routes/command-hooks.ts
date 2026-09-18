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
 * command.executed — /command 실행은 여기서 항상 새로 기록하고 턴 결과로 finish한다.
 * 큐·스케줄러는 run을 미리 만들지 않으므로 상관시킬 상대가 없다 (사체 코드 제거됨).
 * 큐 발송분이면 남겨둔 스냅샷(세션 오버라이드)을 싣는다. 없으면 MISS 로그를 남긴다.
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
  const directory = await fetchSessionDirectory(sessionID)
  const { resolveCommandKind, takeDispatchContext } = await import('../services/command-hooks')
  const { recordRunStartSafe, resolveRepoId, finishRunSafe, attachMessage } = await import('../services/command-runs')
  const kind = resolveCommandKind(directory, name)
  const snap = takeDispatchContext(sessionID, name)
  if (!snap) logger.warn(`Hook command /${name}: snapshot MISS (session ${sessionID}) — review falls back to repo settings`)
  const run = await recordRunStartSafe(db, {
    sessionId: sessionID,
    commandName: name,
    args: cleanArgsForHistory(args),
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
  const { resolveCommandKind, takeDispatchContext } = await import('../services/command-hooks')
  const { recordRunStartSafe, resolveRepoId, finishRunSafe, attachMessage, listRunsBySession } = await import('../services/command-runs')
  // 중복 판정은 messageId 기준 1회 조회 — 같은 메시지의 스킬은 다시 기록하지 않는다.
  // 시간 윈도우가 아니라 재시작 후에도, 같은 턴 반복에도 안전하다.
  let recordedKeys: Set<string>
  try {
    const runs = await listRunsBySession(db, sessionID)
    recordedKeys = new Set(
      runs.flatMap((r) => ((r as { messageId?: string }).messageId ? [`${r.commandName}\n${(r as { messageId?: string }).messageId}`] : [])),
    )
  } catch {
    recordedKeys = new Set()
  }
  for (const m of fresh) {
    const msgId = (m.info as { id?: string } | undefined)?.id
    const parts = (m as { parts?: Array<Record<string, unknown>> }).parts ?? []
    for (const p of parts) {
      if (p?.type !== 'tool' || (p as { tool?: string }).tool !== 'skill') continue
      const state = (p as { state?: { status?: string; input?: { name?: string } } }).state
      const skillName = state?.input?.name
      if (!skillName) continue
      const dedupKey = `${skillName}\n${msgId ?? ''}`
      if (recordedKeys.has(dedupKey)) continue
      const snap = takeDispatchContext(sessionID, skillName)
      if (!snap) logger.warn(`Hook auto skill /${skillName}: snapshot MISS (session ${sessionID}) — review falls back to repo settings`)
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
