import { Database } from 'bun:sqlite'
import { getOpenCodeDbPath } from './opencode-db'
import { logger } from '../utils/logger'

/**
 * opencode SQLite를 직접 읽는 세션 메시지 접근 계층.
 *
 * opencode HTTP API(GET /session/:id/message)는 페이지네이션을 지원하지 않아
 * 호출 한 번에 세션 전체(JSON 수 GB 가능)를 직렬화·전송·파싱한다 — 메모리
 * 누수의 근본 원인. 이 모듈의 모든 함수는 SQL 레벨에서 COUNT/LIMIT/OFFSET
 * 으로 필요한 구간만 읽으므로 전체 메시지 로드가 절대 발생하지 않는다.
 *
 * - message.data: info JSON (id/sessionID 없음 — 컬럼에서 주입)
 * - part.data: part JSON (id/messageID/sessionID 없음 — 컬럼에서 주입)
 * - 인덱스: message(session_id,time_created,id), part(message_id,id) —
 *   아래 쿼리는 전부 인덱스 범위 스캌이다.
 */

export interface MessageListItem {
  id: string
  role: string
  created: number
  preview: string
}

/** opencode HTTP 응답과 동일한 모양: { info, parts }[] */
export interface DbFullMessage {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

/** 이 크기를 넘는 part 본문은 JS로 통째 파싱하지 않고 SQL에서 head만 추출한다. */
const PART_INLINE_LIMIT = 65536
const HEAD_KEEP = 20000
const TRUNCATE_NOTICE = '\n\n…[output truncated for memory — see full log in session]'

async function openOcDb(): Promise<Database | null> {
  try {
    // 컨테이너/테스트 등에서 직접 지정 가능. 없으면 opencode 바이너리로 경로 확인.
    const override = (process.env.OPENCODE_DB_PATH || '').trim()
    const dbPath = override || (await getOpenCodeDbPath())
    if (!dbPath) return null
    return new Database(dbPath, { readonly: true })
  } catch (error) {
    logger.warn('Failed to open OpenCode DB (readonly):', error)
    return null
  }
}

function safeParse(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {}
  try {
    const v = JSON.parse(json) as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 1. 개수 전용 — 메시지 본문을 일절 읽지 않는다 (상단 표기용). */
export async function countSessionMessages(sessionId: string): Promise<number | null> {
  const oc = await openOcDb()
  if (!oc) return null
  try {
    const row = oc
      .query('SELECT COUNT(*) AS c FROM message WHERE session_id = ?')
      .get(sessionId) as { c: number }
    return row.c
  } finally {
    oc.close()
  }
}

interface MessageRow {
  id: string
  data: string
  time_created: number
}

/** 2. 검색 메뉴 진입 시 소량 리스트 — id/role/시간/미리보기만 (parts 없음). */
export async function listSessionMessages(
  sessionId: string,
  limit = 20,
  offset = 0,
): Promise<{ total: number; items: MessageListItem[] } | null> {
  const lim = Math.max(1, Math.min(100, limit))
  const off = Math.max(0, offset)
  const oc = await openOcDb()
  if (!oc) return null
  try {
    const total = (
      oc.query('SELECT COUNT(*) AS c FROM message WHERE session_id = ?').get(sessionId) as { c: number }
    ).c
    const rows = oc
      .query(
        'SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC, rowid DESC LIMIT ? OFFSET ?',
      )
      .all(sessionId, lim, off) as MessageRow[]
    if (rows.length === 0) return { total, items: [] }
    const previews = readPreviews(oc, rows.map((r) => r.id))
    const items = rows.map((r) => {
      const role = typeof safeParse(r.data).role === 'string' ? (safeParse(r.data).role as string) : 'unknown'
      return { id: r.id, role, created: r.time_created, preview: previews.get(r.id) ?? '(empty)' }
    })
    return { total, items }
  } finally {
    oc.close()
  }
}

/** 같은 세션의 여러 메시지에 대한 첫 텍스트 미리보기(200자)를 SQL에서 잘라 가져온다. */
function readPreviews(oc: Database, messageIds: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (messageIds.length === 0) return out
  const rows = oc
    .query(
      `SELECT message_id AS mid, json_extract(data,'$.type') AS ty, json_extract(data,'$.tool') AS tool,
              substr(json_extract(data,'$.text'),1,200) AS t
       FROM part WHERE message_id IN (SELECT value FROM json_each(?))
       ORDER BY message_id, time_created, rowid`,
    )
    .all(JSON.stringify(messageIds)) as Array<{ mid: string; ty: string | null; tool: string | null; t: string | null }>
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.mid)) continue
    seen.add(r.mid)
    if (r.t != null && r.t !== '') out.set(r.mid, r.t)
    else if (r.ty === 'tool') out.set(r.mid, r.tool ? `[tool:${r.tool}]` : '[tool]')
    else if (r.ty === 'file') out.set(r.mid, '[file]')
    else out.set(r.mid, '(empty)')
  }
  return out
}

interface PartRow {
  id: string
  message_id: string
  session_id: string
  len: number
  data: string | null
  type: string | null
  tool: string | null
  callID: string | null
  timejson: string | null
  texthead: string | null
  status: string | null
  title: string | null
  statetime: string | null
  outhead: string | null
  metahead: string | null
  hasout: number
}

/** 지정된 메시지들의 part를 읽는다. 큰 part는 SQL head 추출로 JS 파싱을 피한다. */
function readCappedParts(oc: Database, messageIds: string[]): Map<string, Array<Record<string, unknown>>> {
  const out = new Map<string, Array<Record<string, unknown>>>()
  if (messageIds.length === 0) return out
  for (const id of messageIds) out.set(id, [])
  const rows = oc
    .query(
      `SELECT id, message_id, session_id, length(data) AS len,
              CASE WHEN length(data) <= ${PART_INLINE_LIMIT} THEN data ELSE NULL END AS data,
              json_extract(data,'$.type') AS type,
              json_extract(data,'$.tool') AS tool,
              json_extract(data,'$.callID') AS callID,
              json_extract(data,'$.time') AS timejson,
              substr(json_extract(data,'$.text'),1,${HEAD_KEEP}) AS texthead,
              json_extract(data,'$.state.status') AS status,
              json_extract(data,'$.state.title') AS title,
              json_extract(data,'$.state.time') AS statetime,
              substr(json_extract(data,'$.state.output'),1,${HEAD_KEEP}) AS outhead,
               substr(json_extract(data,'$.state.metadata.output'),1,${HEAD_KEEP}) AS metahead,
               CASE WHEN json_extract(data,'$.state.output') IS NOT NULL THEN 1 ELSE 0 END AS hasout
       FROM part WHERE message_id IN (SELECT value FROM json_each(?))
       ORDER BY time_created, rowid`,
    )
    .all(JSON.stringify(messageIds)) as PartRow[]
  for (const r of rows) {
    const list = out.get(r.message_id)
    if (!list) continue
    list.push(buildPart(r))
  }
  return out
}

function buildPart(r: PartRow): Record<string, unknown> {
  const base = { id: r.id, messageID: r.message_id, sessionID: r.session_id }
  if (r.data != null) {
    // 작은 part는 그대로 (호출자가 필요시 cap — 폴링 경로는 프론트 truncate가 2차 방어)
    return { ...safeParse(r.data), ...base }
  }
  const notice = `${TRUNCATE_NOTICE} (${Math.max(0, r.len - HEAD_KEEP)} chars omitted)`
  if (r.type === 'text' || r.type === 'reasoning') {
    // NOTE: opencode는 reasoning part를 {type,text,time}만 저장한다 (실DB 11,714건 전수 확인).
    // 서명 필드가 애초에 없으므로 heal은 서명이 아니라 완료 여부로 오염을 판별한다.
    return { ...base, type: r.type, time: safeParse(r.timejson), text: `${r.texthead ?? ''}${notice}` }
  }
  if (r.type === 'tool') {
    const state: Record<string, unknown> = { status: r.status ?? 'completed' }
    if (r.title) state.title = r.title
    if (r.timejson) state.time = safeParse(r.statetime)
    if (r.hasout) state.output = `${r.outhead ?? ''}${notice}`
    else state.metadata = { output: `${r.metahead ?? ''}${notice}` }
    const part: Record<string, unknown> = { ...base, type: 'tool', state }
    if (r.tool) part.tool = r.tool
    if (r.callID) part.callID = r.callID
    return part
  }
  logger.warn(`Oversized part of unexpected type '${r.type}' omitted (id=${r.id}, ${r.len} chars)`)
  return { ...base, type: 'text', text: `[part omitted: ${r.type ?? 'unknown'} output too large (${r.len} chars) — see full log in session]` }
}

/** 폴링용 최근 N개 전체 메시지 (parts 포함, cap 적용). 응답 순서: 시간 오름차순. */
export async function recentSessionMessages(
  sessionId: string,
  limit = 60,
): Promise<{ total: number; messages: DbFullMessage[] } | null> {
  const lim = Math.max(1, Math.min(200, limit))
  const oc = await openOcDb()
  if (!oc) return null
  try {
    const total = (
      oc.query('SELECT COUNT(*) AS c FROM message WHERE session_id = ?').get(sessionId) as { c: number }
    ).c
    const rows = oc
      .query(
        'SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC, rowid DESC LIMIT ?',
      )
      .all(sessionId, lim) as MessageRow[]
    const asc = rows.reverse()
    const partsByMessage = readCappedParts(
      oc,
      asc.map((r) => r.id),
    )
    const messages = asc.map((r) => ({
      info: { ...safeParse(r.data), id: r.id, sessionID: sessionId },
      parts: partsByMessage.get(r.id) ?? [],
    }))
    return { total, messages }
  } finally {
    oc.close()
  }
}

export interface ReasoningModelStat {
  providerID: string
  modelID: string
  turns: number
}

/**
 * 히스토리에 reasoning을 남긴 모델 분포 (모델 스위치 탐지용).
 * parts 본문은 읽지 않고 id/type만 보므로 전체 로드 없이 집계된다.
 * reasoning이 없는 세션은 빈 배열.
 */
export async function historyReasoningModels(sessionId: string): Promise<ReasoningModelStat[] | null> {
  const oc = await openOcDb()
  if (!oc) return null
  try {
    const rows = oc
      .query(
        `SELECT json_extract(m.data,'$.providerID') AS prov,
                json_extract(m.data,'$.modelID') AS model,
                COUNT(DISTINCT m.id) AS turns
         FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND json_extract(p.data,'$.type') = 'reasoning'
         GROUP BY 1, 2`,
      )
      .all(sessionId) as Array<{ prov: unknown; model: unknown; turns: number }>
    return rows
      .filter((r) => typeof r.prov === 'string' && typeof r.model === 'string')
      .map((r) => ({ providerID: r.prov as string, modelID: r.model as string, turns: r.turns }))
  } finally {
    oc.close()
  }
}

/** 점프용 윈도우: around 메시지 전후 limit개 (parts 포함, cap 적용). */
export async function windowSessionMessages(
  sessionId: string,
  aroundId: string,
  limit = 30,
): Promise<{ total: number; found: boolean; messages: DbFullMessage[] } | null> {
  const lim = Math.max(1, Math.min(100, limit))
  const oc = await openOcDb()
  if (!oc) return null
  try {
    const total = (
      oc.query('SELECT COUNT(*) AS c FROM message WHERE session_id = ?').get(sessionId) as { c: number }
    ).c
    const anchor = oc
      .query('SELECT time_created AS t, rowid AS r FROM message WHERE session_id = ? AND id = ?')
      .get(sessionId, aroundId) as { t: number; r: number } | undefined
    if (!anchor) return { total, found: false, messages: [] }
    const rank = (
      oc
        .query(
          'SELECT COUNT(*) AS c FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND rowid < ?))',
        )
        .get(sessionId, anchor.t, anchor.t, anchor.r) as { c: number }
    ).c
    const offset = Math.max(0, rank - Math.floor(lim / 2))
    const rows = oc
      .query(
        'SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, rowid LIMIT ? OFFSET ?',
      )
      .all(sessionId, lim, offset) as MessageRow[]
    const partsByMessage = readCappedParts(
      oc,
      rows.map((r) => r.id),
    )
    const messages = rows.map((r) => ({
      info: { ...safeParse(r.data), id: r.id, sessionID: sessionId },
      parts: partsByMessage.get(r.id) ?? [],
    }))
    return { total, found: true, messages }
  } finally {
    oc.close()
  }
}
