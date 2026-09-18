import { existsSync } from 'node:fs'
import path from 'node:path'
import { logger } from '../utils/logger'
import type { CommandRun, CommandRunStatus } from '../db/command-run-queries'
import type { Database } from 'bun:sqlite'
import { getConfigPath } from '@opencode-webui/shared'
import { getSkillAutoReview, getSkillAutoUpdate } from '../db/queries'

/**
 * 모든 커맨드 실행에 붙는 수행 프로토콜. todo 툴이 있으면(지원되는 경우)
 * 먼저 todo로 정리하고 단계별 실행, 마지막 complete 전까지는 todo
 * 업데이트만, 오류 판단은 todo 실패 또는 처리불가 중단일 때만.
 */
export const TODO_PROTOCOL =
  '[execution-protocol] If a todo tool is available, first break this task into todos, ' +
  'then execute step by step updating todo status as you go. Until the final complete, ' +
  'report progress only via todo updates (no intermediate summaries); write the final summary ' +
  'only at complete. Treat the run as failed only if a todo fails or you stop because the task ' +
  'is unprocessable — transient tool errors are not failures, keep going.'

export type CommandHookPhase = 'pre' | 'post'

export interface CommandHookCall {
  phase: CommandHookPhase
  runId: string
  sessionId: string
  commandName: string
  origin: string
  status: CommandRunStatus | null
  directory: string | null
  repoId: number | null
  at: number
}

const MAX_RECENT = 50
const recentCalls: CommandHookCall[] = []

const pendingSkillChecks = new Map<string, { commandName: string; status: string; at: number; kind: string }>()

/** consume 기한(5분)이 지나면 어차피 null이라 읽히지 않는다 — 죽은 엔트리 정리용. */
const PENDING_TTL_MS = 5 * 60 * 1000

export function getAndClearPendingSkillCheck(sessionId: string): { commandName: string; status: string; kind: string } | null {
  const v = pendingSkillChecks.get(sessionId)
  if (!v) return null
  pendingSkillChecks.delete(sessionId)
  if (Date.now() - v.at > PENDING_TTL_MS) return null
  return v
}

/**
 * consume 기한이 지난 죽은 엔트리 정리. 다음 메시지가 오지 않는 세션은
 * 읽힐 일이 없어 무한 누적되므로, post 훅에서 매번 호출한다. 제거 수 반환.
 */
export function pruneExpiredSkillChecks(now: number = Date.now()): number {
  let removed = 0
  for (const [sid, v] of pendingSkillChecks) {
    if (now - v.at > PENDING_TTL_MS) {
      pendingSkillChecks.delete(sid)
      removed++
    }
  }
  return removed
}

export function getRecentHookCalls(): CommandHookCall[] {
  return [...recentCalls]
}

/**
 * 리뷰 자식 세션 ID → 생성 시각 — 여기서 실행된 커맨드는 다시 리뷰를 낳지
 * 않는다 (루프 가드). add만 있고 정리 경로가 없어 무한 누적되므로 TTL(24h) +
 * 상한(1000개, 초과분은 가장 오래된 것부터 evict)을 둔다.
 */
export const REVIEW_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const REVIEW_SESSION_MAX = 1000
const reviewSessions = new Map<string, number>()

export function isReviewSession(sessionId: string, now: number = Date.now()): boolean {
  const at = reviewSessions.get(sessionId)
  if (at == null) return false
  if (now - at > REVIEW_SESSION_TTL_MS) {
    reviewSessions.delete(sessionId)
    return false
  }
  return true
}

function rememberReviewSession(sessionId: string): void {
  reviewSessions.delete(sessionId)
  reviewSessions.set(sessionId, Date.now())
  while (reviewSessions.size > REVIEW_SESSION_MAX) {
    const oldest = reviewSessions.keys().next().value as string | undefined
    if (oldest === undefined) break
    reviewSessions.delete(oldest)
  }
}

/** 스킬 파일 존재 여부로 kind 판별 (project → global 순). */
export function resolveCommandKind(directory: string | null | undefined, commandName: string): 'skill' | 'command' {
  const clean = commandName.trim().replace(/[\\:*?"<>|]/g, '-')
  if (!clean) return 'command'
  try {
    if (directory && existsSync(path.join(directory, '.opencode', 'skills', clean, 'SKILL.md'))) return 'skill'
  } catch {}
  try {
    const root = getConfigPath()
    if (existsSync(path.join(root, 'skills', clean, 'SKILL.md'))) return 'skill'
  } catch {}
  return 'command'
}

/**
 * 부모 세션에 주입할 skill-memory-check 블록. pending이 없으면 ''.
 * 읽는 즉시 consume하므로 리뷰 자식이 생긴 뒤에는 부모에 중복 주입되지 않는다.
 * auto(자동 변경 ON)=build: 직접 수정 지시 / OFF=plan: 채팅 승인 요청.
 */
export function buildSkillCheckBlock(opts: {
  sessionId: string
  repoId?: number | null
  db?: Database
}): string {
  const pending = getAndClearPendingSkillCheck(opts.sessionId)
  if (!pending) return ''
  let auto = false
  try {
    if (opts.db && opts.repoId != null) auto = getSkillAutoUpdate(opts.db, opts.repoId)
  } catch {}
  if (auto) {
    return `<skill-memory-check>\nLast ${pending.kind} "${pending.commandName}" completed with status "${pending.status}". Skill auto update is ENABLED for this repo. Please evaluate if skill or memory needs update and if there are improvements, update directly without asking user.\n</skill-memory-check>\n\n`
  }
  return `<skill-memory-check>\nLast ${pending.kind} "${pending.commandName}" completed with status "${pending.status}".\nPlease evaluate if skill or memory needs update and if there are improvements. If yes, ask the user in chat for approval before updating (in Korean, concise).\n</skill-memory-check>\n\n`
}

export function clearRecentHookCalls(): void {
  recentCalls.length = 0
}

function record(call: CommandHookCall): void {
  recentCalls.unshift(call)
  if (recentCalls.length > MAX_RECENT) recentCalls.length = MAX_RECENT
}

function toCall(run: CommandRun, phase: CommandHookPhase, status: CommandRunStatus): CommandHookCall {
  return {
    phase,
    runId: run.id,
    sessionId: run.sessionId,
    commandName: run.commandName,
    origin: run.origin,
    status: phase === 'post' ? status : null,
    directory: run.directory,
    repoId: run.repoId,
    at: Date.now(),
  }
}

async function preCommand(run: CommandRun, db?: Database): Promise<void> {
  const call = toCall(run, 'pre', 'started')
  record(call)
  logger.info(
    `[pre-command] ${run.commandName} (run=${run.id}, origin=${run.origin}, session=${run.sessionId})`
  )
  if (db && run.commandName) {
    try {
      // 진단용 로그만 남긴다 — 이 훅은 기록용이라 여기서 만든 블록을 프롬프트에
      // 붙일 수 없다. 실제 주입은 발송 직전 dispatchQueuedChat에서 한다.
      const { buildRecall } = await import('./recall')
      const q = `${run.commandName} ${run.args ?? ''}`.trim().slice(0, 200)
      const { hits } = buildRecall(db, q, { k: 3, repoId: run.repoId ?? undefined })
      if (hits.length > 0) {
        logger.info(`[pre-command] recall for ${run.commandName}: ${hits.map((h) => `${h.kind}:${h.snippet.slice(0, 40)}`).join(' | ')}`)
      }
    } catch (e) {
      logger.debug('[pre-command] recall skipped:', e)
    }
  }
}

async function postCommand(run: CommandRun, status: Exclude<CommandRunStatus, 'started'>, db?: Database): Promise<void> {
  const call = toCall(run, 'post', status)
  record(call)
  logger.info(
    `[post-command] ${run.commandName} status=${status} (run=${run.id}, origin=${run.origin}, session=${run.sessionId})`
  )
  if ((run.kind === 'skill' || run.kind === 'command') && run.commandName) {
    pruneExpiredSkillChecks()
    pendingSkillChecks.set(run.sessionId, { commandName: run.commandName, status, at: Date.now(), kind: run.kind })
  }
  if (db && run.repoId != null && status === 'completed') {
    try {
      const { indexRepoCommits, listAllIndexedRepos, HOST_REPO_ID } = await import('./git-indexer')
      const { getRepoById } = await import('../db/queries')
      const target =
        run.repoId === HOST_REPO_ID
          ? listAllIndexedRepos(db).find((r) => r.id === HOST_REPO_ID) ?? null
          : getRepoById(db, run.repoId)
      if (target) {
        void indexRepoCommits(db, target).catch((e) => logger.debug('[post-command] git reindex skipped:', e))
      }
    } catch (e) {
      logger.debug('[post-command] git reindex skipped:', e)
    }
  }
  // 자동 리뷰 ON이면 리뷰 자식 세션 생성 (성공 시 부모 pending consume → 중복 주입 방지).
  // 리뷰 세션 자체·실패 턴·directory 없는 실행은 제외.
  if ((run.kind === 'skill' || run.kind === 'command') && run.commandName) {
    void maybeSpawnReviewChild({
      sessionId: run.sessionId,
      directory: run.directory,
      repoId: run.repoId,
      commandName: run.commandName,
      args: run.args,
      kind: run.kind,
      status,
      origin: run.origin,
      reviewWanted: run.reviewWanted,
      autoApply: run.autoApply,
      db,
    }).catch((e) => logger.debug('[post-command] review spawn skipped:', e))
  }
}

export function firePreCommandHooks(run: CommandRun, db?: Database): void {
  void preCommand(run, db).catch((error: unknown) => {
    logger.warn('pre-command hook failed:', error)
  })
}

export function firePostCommandHooks(
  run: CommandRun,
  status: Exclude<CommandRunStatus, 'started'>,
  db?: Database
): void {
  void postCommand(run, status, db).catch((error: unknown) => {
    logger.warn('post-command hook failed:', error)
  })
}

/**
 * 자동 리뷰: 스킬/커맨드 완료 후 리뷰 자식 세션을 생성한다.
 * - parentID로 진짜 하위 세션을 만든다 (기록은 비어 있고 /children 연결).
 *   마지막 결과 요약만 프롬프트에 실어 보낸다.
 * - 자동 리뷰 OFF → null (부모 채팅의 skill-memory-check가 대신 동작).
 * - 성공 시에만 생성 (실패 턴은 부모에서 재시도/정리 대상).
 * - 자식 세션에서 실행된 커맨드는 다시 리뷰를 낳지 않는다.
 * - agent는 자동 변경 ON=build(직접 수정) / OFF=plan(읽기전용·제안만).
 * - spawn 실패 시 pending을 남겨 부모 주입으로 폴백한다.
 */
export async function maybeSpawnReviewChild(opts: {
  sessionId: string
  directory: string | null
  repoId: number | null
  commandName: string
  args?: string | null
  kind: string
  status: Exclude<CommandRunStatus, 'started'>
  origin?: string
  /**
   * run 행에 실린 세션 오버라이드 스냅샷. undefined면 상속 = 레포 DB 설정을 따른다.
   * 프론트 세션 토글이 localStorage 전용이라 enqueue→run 행으로 운반된다.
   */
  reviewWanted?: boolean
  autoApply?: boolean
  db?: Database
}): Promise<string | null> {
  const { sessionId, directory, commandName, kind, status } = opts
  if (isReviewSession(sessionId)) return null
  if (status !== 'completed') return null
  if (!directory) return null

  let repoId = opts.repoId
  try {
    if (repoId == null && opts.db && directory) {
      const { resolveRepoId } = await import('./command-runs')
      repoId = resolveRepoId(opts.db, directory)
    }
  } catch {}
  let autoReview = opts.reviewWanted ?? false
  let autoApply = opts.autoApply ?? false
  let repoReviewDef: boolean | undefined
  let repoAutoDef: boolean | undefined
  try {
    if (opts.db && repoId != null) {
      if (opts.reviewWanted === undefined) autoReview = getSkillAutoReview(opts.db, repoId)
      if (opts.autoApply === undefined) autoApply = getSkillAutoUpdate(opts.db, repoId)
      repoReviewDef = getSkillAutoReview(opts.db, repoId)
      repoAutoDef = getSkillAutoUpdate(opts.db, repoId)
    }
  } catch {}
  // 판정 추적: 스냅샷 유실인지 레포 설정인지 여기서 갈린다
  logger.info(
    `Review spawn decision /${commandName} (session ${sessionId}): ` +
      `autoApply=${autoApply} (snapshot=${opts.autoApply === undefined ? 'inherit' : String(opts.autoApply)}, repoAuto=${repoAutoDef === undefined ? 'n/a' : repoAutoDef}), ` +
      `autoReview=${autoReview} (snapshot=${opts.reviewWanted === undefined ? 'inherit' : String(opts.reviewWanted)}, repoReview=${repoReviewDef === undefined ? 'n/a' : repoReviewDef}) ` +
      `-> agent=${autoApply ? 'build' : 'plan'}`,
  )
  if (!autoReview) {
    logger.debug(`Review spawn skipped for /${commandName}: autoReview off (run override ${String(opts.reviewWanted)}, repo ${repoId})`)
    return null
  }

  try {
    const { opencodeServerManager } = await import('./opencode-single-server')
    const { ensureServerAuth } = await import('./opencode-auth')
    const base = opencodeServerManager.getUrl()
    const headers = ensureServerAuth({ 'Content-Type': 'application/json' })
    const directoryParam = encodeURIComponent(directory)

    // parentID로 진짜 하위 세션을 만든다 (기록은 비어 있고 /children에 연결).
    // fork는 그 지점까지의 대화 전체를 복제해서 리뷰 용도에 과하다.
    // 타이틀에 리뷰 일시를 달아 목록에서 구분한다.
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    const reviewTitle = `[REVIEW] /${commandName} ${stamp}`
    const createRes = await fetch(`${base}/session?directory=${directoryParam}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parentID: sessionId, title: reviewTitle }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!createRes.ok) {
      logger.warn(`Review spawn: session create failed HTTP ${createRes.status} for /${commandName}`)
      return null
    }
    const child = (await createRes.json()) as { id?: string }
    if (!child?.id) return null
    const childId = child.id
    rememberReviewSession(childId)

    // 빈 자식은 서버 기본 모델을 물려받는다 (fork처럼 부모 모델이 안 이어진다).
    // 부모 모델을 읽어 명시 전달 — 아니면 이미지 모델 같은 기본값이 리뷰를 망친다.
    let parentModel: { providerID: string; modelID: string } | undefined
    try {
      const infoRes = await fetch(`${base}/session/${sessionId}?directory=${directoryParam}`, {
        headers: ensureServerAuth({}),
        signal: AbortSignal.timeout(15_000),
      })
      if (infoRes.ok) {
        const info = (await infoRes.json()) as { model?: { providerID?: string; id?: string } }
        if (info?.model?.providerID && info?.model?.id) {
          parentModel = { providerID: info.model.providerID, modelID: info.model.id }
        }
      }
    } catch {}

    // 부모의 마지막 결과를 잘라 자식에게 근거로 전달 (없으면 생략 — fail-open).
    // DB 직접 조회라 전체 HTTP 로드 없이 꼬리 5건이면 충분하다.
    let snippet = ''
    try {
      const { recentSessionMessages } = await import('./session-message-db')
      const tail = await recentSessionMessages(sessionId, 5)
      const msgs = [...(tail?.messages ?? [])].reverse()
      for (const m of msgs) {
        const info = m.info as { role?: string } | undefined
        if (info?.role !== 'assistant') continue
        const text = (m.parts ?? [])
          .filter((p) => p?.type === 'text' && typeof p.text === 'string' && (p.text as string).trim())
          .map((p) => p.text as string)
          .join('\n')
          .trim()
        if (text) {
          snippet = text.length > 4000 ? text.slice(-4000) : text
          break
        }
      }
    } catch {}

    const mode = autoApply ? 'BUILD' : 'PLAN'
    const modeRule = autoApply
      ? 'Mode: BUILD — you may apply changes directly when you judge them safe and correct.'
      : 'Mode: PLAN — read-only. Do NOT edit, write, or delete any files. Investigate and propose.'
    const applyStep = autoApply
      ? 'Apply the improvement directly if any, then summarize briefly in Korean. If nothing to improve, reply "no update needed".'
      : 'Do NOT apply anything. Reply with the proposed diff or "no update needed", concise Korean.'
    const prompt =
      `[review] Command "/${commandName}${opts.args ? ` ${opts.args}` : ''}" finished with status "${status}" ` +
      `in session ${sessionId} (origin ${opts.origin ?? 'chat'}).\n${modeRule}\n` +
      `Execution protocol: if a todo tool is available, first break this review into todos, then work step by step ` +
      `updating todo status as you go. Until the final complete, report progress only via todo updates; write the ` +
      `final summary only at complete. Treat the review as failed only if a todo fails or you stop because it is ` +
      `unprocessable — transient tool errors are not failures.\n` +
      `1. Re-read the ${kind} definition for "/${commandName}" and the repo state under ${directory}.\n` +
      `2. Evaluate whether the skill/command definition or memory needs an update based on this run.\n` +
      `3. ${applyStep}` +
      (snippet ? `\nParent's last result (truncated):\n${snippet}` : '')

    const sendBody: Record<string, unknown> = {
      parts: [{ type: 'text', text: prompt }],
      agent: autoApply ? 'build' : 'plan',
      ...(parentModel ? { model: parentModel } : {}),
    }
    const sendRes = await fetch(`${base}/session/${childId}/message?directory=${directoryParam}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(sendBody),
      signal: AbortSignal.timeout(600_000),
    })
    if (!sendRes.ok) {
      const t = await sendRes.text().catch(() => '')
      logger.warn(`Review spawn: review prompt rejected HTTP ${sendRes.status} for /${commandName}: ${t.slice(0, 200)}`)
      return childId
    }
    void sendRes.text().catch(() => {})
    // 자식이 생겼으니 부모에는 중복 주입하지 않는다.
    getAndClearPendingSkillCheck(sessionId)
    logger.info(`Review spawn: child ${childId} (${mode}) for /${commandName} from ${sessionId}`)
    return childId
  } catch (e) {
    logger.warn(`Review spawn failed for /${commandName}:`, e)
    return null
  }
}
