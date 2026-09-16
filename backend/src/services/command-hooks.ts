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

export function getAndClearPendingSkillCheck(sessionId: string): { commandName: string; status: string; kind: string } | null {
  const v = pendingSkillChecks.get(sessionId)
  if (!v) return null
  pendingSkillChecks.delete(sessionId)
  if (Date.now() - v.at > 5 * 60 * 1000) return null
  return v
}

export function getRecentHookCalls(): CommandHookCall[] {
  return [...recentCalls]
}

/** 리뷰 자식 세션 ID — 여기서 실행된 커맨드는 다시 리뷰를 낳지 않는다 (루프 가드). */
const reviewSessions = new Set<string>()

export function isReviewSession(sessionId: string): boolean {
  return reviewSessions.has(sessionId)
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
  db?: Database
}): Promise<string | null> {
  const { sessionId, directory, commandName, kind, status } = opts
  if (reviewSessions.has(sessionId)) return null
  if (status !== 'completed') return null
  if (!directory) return null

  let repoId = opts.repoId
  try {
    if (repoId == null && opts.db && directory) {
      const { resolveRepoId } = await import('./command-runs')
      repoId = resolveRepoId(opts.db, directory)
    }
  } catch {}
  let autoReview = false
  let autoApply = false
  try {
    if (opts.db && repoId != null) {
      autoReview = getSkillAutoReview(opts.db, repoId)
      autoApply = getSkillAutoUpdate(opts.db, repoId)
    }
  } catch {}
  if (!autoReview) return null

  try {
    const { opencodeServerManager } = await import('./opencode-single-server')
    const { ensureServerAuth } = await import('./opencode-auth')
    const base = opencodeServerManager.getUrl()
    const headers = ensureServerAuth({ 'Content-Type': 'application/json' })
    const directoryParam = encodeURIComponent(directory)

    const createRes = await fetch(`${base}/session?directory=${directoryParam}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: `[REVIEW] /${commandName}` }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!createRes.ok) {
      logger.warn(`Review spawn: session create failed HTTP ${createRes.status} for /${commandName}`)
      return null
    }
    const child = (await createRes.json()) as { id: string }
    if (!child?.id) return null
    reviewSessions.add(child.id)

    // 부모의 마지막 결과를 잘라 자식에게 근거로 전달 (없으면 생략 — fail-open)
    let snippet = ''
    try {
      const msgRes = await fetch(`${base}/session/${sessionId}/message?directory=${directoryParam}`, {
        headers: ensureServerAuth({}),
        signal: AbortSignal.timeout(20_000),
      })
      if (msgRes.ok) {
        const messages = (await msgRes.json()) as Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.info?.role === 'assistant') {
            const text = (messages[i]?.parts ?? [])
              .filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
              .map((p) => p.text as string)
              .join('\n')
              .trim()
            if (text) snippet = text.length > 4000 ? text.slice(-4000) : text
            break
          }
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

    const sendBody: Record<string, unknown> = { parts: [{ type: 'text', text: prompt }], agent: autoApply ? 'build' : 'plan' }
    const sendRes = await fetch(`${base}/session/${child.id}/message?directory=${directoryParam}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(sendBody),
      signal: AbortSignal.timeout(600_000),
    })
    if (!sendRes.ok) {
      const t = await sendRes.text().catch(() => '')
      logger.warn(`Review spawn: review prompt rejected HTTP ${sendRes.status} for /${commandName}: ${t.slice(0, 200)}`)
      return child.id
    }
    void sendRes.text().catch(() => {})
    // 자식이 생겼으니 부모에는 중복 주입하지 않는다.
    getAndClearPendingSkillCheck(sessionId)
    logger.info(`Review spawn: child ${child.id} (${mode}) for /${commandName} from ${sessionId}`)
    return child.id
  } catch (e) {
    logger.warn(`Review spawn failed for /${commandName}:`, e)
    return null
  }
}
