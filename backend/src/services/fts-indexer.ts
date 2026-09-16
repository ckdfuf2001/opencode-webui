import type { Database } from 'bun:sqlite'
import { getOpenCodeDbPath } from './opencode-db'
import { resolveRepoId } from './command-runs'
import { logger } from '../utils/logger'
import path from 'node:path'
import fs from 'node:fs'

const HOST_REPO_ID = 0
function isHostDirectory(dir: string): boolean {
  try {
    const host = path.resolve(process.cwd())
    if (!fs.existsSync(path.join(host, '.git'))) return false
    const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const hostNorm = host.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (norm === hostNorm) return true
    if (norm.startsWith(hostNorm + '/')) {
      const reposPrefix = (hostNorm + '/workspace/repos/').toLowerCase()
      if (norm.startsWith(reposPrefix)) return false
      return true
    }
    return false
  } catch {
    return false
  }
}

const SNIPPET_SIZE = 24

/**
 * 오픈코드 DB(message/part)에서 세션 전체 메시지를 pull하여 백엔드 DB의
 * session_messages_fts(trigram)를 해당 세션 단위로 재구축한다.
 * truncate/delete 로 지워진 메시지를 반영하기 위해 idle 마다 세션 단위 rebuild 를 쓴다.
 */
export async function indexSessionMessages(db: Database, sessionId: string): Promise<number> {
  const dbPath = await getOpenCodeDbPath()
  if (!dbPath) return 0
  const oc = new (await import('bun:sqlite')).Database(dbPath, { readonly: true })
  try {
    const sess = oc
      .query('SELECT directory FROM session WHERE id = ?')
      .get(sessionId) as { directory: string | null } | undefined
    if (!sess || !sess.directory) return 0
    let repoId = resolveRepoId(db, sess.directory)
    if (repoId == null && isHostDirectory(sess.directory)) repoId = HOST_REPO_ID

    db.query('DELETE FROM session_messages_fts WHERE session_id = ?').run(sessionId)

    const messages = oc
      .query('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC')
      .all(sessionId) as { id: string; data: string; time_created: number }[]

    const upsert = db.prepare(
      `INSERT INTO session_messages_fts (text, session_id, message_id, role, repo_id, turn_index, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    let inserted = 0
    let turnIndex = 0
    for (const m of messages) {
      let role = 'unknown'
      try {
        const parsed = JSON.parse(m.data) as { role?: string }
        role = parsed.role ?? 'unknown'
      } catch {
        // ignore malformed message data
      }
      const text = collectPartText(oc, m.id)
      upsert.run(text, sessionId, m.id, role, repoId ?? null, turnIndex, m.time_created)
      inserted++
      turnIndex++
    }
    return inserted
  } finally {
    oc.close()
  }
}

/** 오픈코드 DB의 모든 세션 id + directory 를 나열한다 (수동 전체 재인덱싱용). */
export async function listAllSessions(): Promise<Array<{ id: string; directory: string | null }>> {
  const dbPath = await getOpenCodeDbPath()
  if (!dbPath) return []
  const oc = new (await import('bun:sqlite')).Database(dbPath, { readonly: true })
  try {
    return oc
      .query('SELECT id, directory FROM session WHERE time_archived IS NULL')
      .all() as Array<{ id: string; directory: string | null }>
  } finally {
    oc.close()
  }
}

export async function indexAllSessions(db: Database): Promise<number> {
  const sessions = await listAllSessions()
  let total = 0
  for (const s of sessions) {
    try {
      total += await indexSessionMessages(db, s.id)
    } catch (error) {
      logger.warn(`Failed to index session ${s.id}:`, error)
    }
  }
  return total
}


/**
 * 세션 FTS 인덱스 증분 동기화 — opencode DB를 ATTACH해서 SQL만으로 처리한다.
 * 삭제된 메시지는 인덱스에서 제거하고, 새로 들어온 메시지만 추가한다.
 * 메시지 본문을 JS로 통째 읽지 않으므로(집계는 SQLite 내부) 전체 로드가 없다.
 * 검색 메뉴 진입 시 1회 호출해 인덱스를 최신으로 맞춘다.
 */
export async function syncSessionMessages(db: Database, sessionId: string): Promise<number> {
  const override = (process.env.OPENCODE_DB_PATH || '').trim()
  const dbPath = override || (await getOpenCodeDbPath())
  if (!dbPath) return 0
  const oc = new (await import('bun:sqlite')).Database(dbPath, { readonly: true })
  try {
    const sess = oc
      .query('SELECT directory FROM session WHERE id = ?')
      .get(sessionId) as { directory: string | null } | undefined
    if (!sess || !sess.directory) return 0
    let repoId = resolveRepoId(db, sess.directory)
    if (repoId == null && isHostDirectory(sess.directory)) repoId = HOST_REPO_ID

    const escaped = dbPath.replace(/'/g, "''")
    db.exec(`ATTACH DATABASE '${escaped}' AS oc`)
    try {
      // 1) 지워진 메시지 정리
      db.query(
        'DELETE FROM session_messages_fts WHERE session_id = ? AND message_id NOT IN (SELECT id FROM oc.message WHERE session_id = ?)',
      ).run(sessionId, sessionId)
      // 2) 새 메시지만 추가 (turn_index는 전체 순서 기준 ROW_NUMBER)
      const missing = db.query(
        `SELECT id, data, tc, ti FROM (
           SELECT id, data, time_created AS tc, rowid AS r,
                  ROW_NUMBER() OVER (ORDER BY time_created, rowid) - 1 AS ti
           FROM oc.message WHERE session_id = ?
         ) WHERE id NOT IN (SELECT message_id FROM session_messages_fts WHERE session_id = ?)
         ORDER BY tc, r`,
      ).all(sessionId, sessionId) as Array<{ id: string; data: string; tc: number; ti: number }>
      if (missing.length === 0) return 0
      const textOf = db.prepare(
        `SELECT group_concat(json_extract(p.data,'$.text'), char(10)) AS tx
         FROM oc.part p WHERE p.message_id = ?
           AND json_extract(p.data,'$.type') = 'text'`,
      )
      const upsert = db.prepare(
        `INSERT INTO session_messages_fts (text, session_id, message_id, role, repo_id, turn_index, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      let inserted = 0
      for (const m of missing) {
        let role = 'unknown'
        try {
          const parsed = JSON.parse(m.data) as { role?: string }
          role = parsed.role ?? 'unknown'
        } catch {
          // ignore malformed message data
        }
        const t = textOf.get(m.id) as { tx: string | null } | undefined
        upsert.run(t?.tx ?? '', sessionId, m.id, role, repoId ?? null, m.ti, m.tc)
        inserted++
      }
      return inserted
    } finally {
      db.exec('DETACH DATABASE oc')
    }
  } finally {
    oc.close()
  }
}

function collectPartText(oc: import('bun:sqlite').Database, messageId: string): string {
  let rows: Array<{ data: string }>
  try {
    rows = oc
      .query('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC')
      .all(messageId) as Array<{ data: string }>
  } catch {
    return ''
  }
  const texts: string[] = []
  for (const r of rows) {
    try {
      const d = JSON.parse(r.data) as { type?: string; text?: unknown }
      if (d?.type === 'text' && typeof d.text === 'string') texts.push(d.text)
    } catch {
      // skip malformed part
    }
  }
  return texts.join('\n')
}

export interface MessageSearchHit {
  sessionId: string
  messageId: string
  role: string
  repoId: number | null
  turnIndex: number
  ts: number
  snippet: string
}


export interface MessageSearchOpts {
  k?: number
  offset?: number
  repoId?: number | null
  sessionId?: string
}

interface SearchFilter {
  where: string[]
  params: (string | number)[]
  orderBy: string
}

/** 분할 검색용 공통 필터 — searchMessages와 countMessageMatches가 공유한다. */
function buildMessageSearchFilter(q: string, opts: MessageSearchOpts): SearchFilter {
  const trimmed = q.trim()
  // 단일 문자 prefix (a*)는 trigram FTS5 prefix로 매칭이 안 되므로 LIKE fallback
  if (/^\p{L}\*$/u.test(trimmed) || /^\p{N}\*$/u.test(trimmed)) {
    const prefix = trimmed.slice(0, -1)
    const where: string[] = ['text LIKE ?']
    const params: (string | number)[] = [`${prefix}%`]
    if (opts.repoId != null) {
      where.push('repo_id = ?')
      params.push(opts.repoId)
    }
    if (opts.sessionId) {
      where.push('session_id = ?')
      params.push(opts.sessionId)
    }
    return { where, params, orderBy: 'ts DESC' }
  }
  if (trimmed === '*') {
    const where: string[] = ['1 = 1']
    const params: (string | number)[] = []
    if (opts.repoId != null) {
      where.push('repo_id = ?')
      params.push(opts.repoId)
    }
    if (opts.sessionId) {
      where.push('session_id = ?')
      params.push(opts.sessionId)
    }
    return { where, params, orderBy: 'ts DESC' }
  }
  const where: string[] = ['session_messages_fts MATCH ?']
  const params: (string | number)[] = [buildFtsQuery(q)]
  if (opts.repoId != null) {
    where.push('repo_id = ?')
    params.push(opts.repoId)
  }
  if (opts.sessionId) {
    where.push('session_id = ?')
    params.push(opts.sessionId)
  }
  return { where, params, orderBy: 'bm25(session_messages_fts)' }
}

type MessageSearchRow = {
  s: string; m: string; r: string; rid: number | null; ti: number; t: number; snip: string
}

function mapSearchRow(row: MessageSearchRow): MessageSearchHit {
  return {
    sessionId: row.s,
    messageId: row.m,
    role: row.r,
    repoId: row.rid,
    turnIndex: row.ti,
    ts: row.t,
    snippet: row.snip,
  }
}

const SEARCH_SELECT = `
  SELECT session_id AS s, message_id AS m, role AS r, repo_id AS rid,
         turn_index AS ti, ts AS t,
         snippet(session_messages_fts, 0, '[', ']', '\u2026', ${SNIPPET_SIZE}) AS snip
  FROM session_messages_fts`

/** 분할 검색 — k개씩 offset부터. 전체 로드 없이 FTS 인덱스에서 페이징한다. */
export function searchMessages(
  db: Database,
  q: string,
  opts: MessageSearchOpts = {},
): MessageSearchHit[] {
  const k = Math.max(1, Math.min(50, opts.k ?? 10))
  const offset = Math.max(0, Math.min(10000, opts.offset ?? 0))
  const { where, params, orderBy } = buildMessageSearchFilter(q, opts)
  const sql = `${SEARCH_SELECT}
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?`
  const rows = db.query(sql).all(...(params as any[]), k, offset) as MessageSearchRow[]
  return rows.map(mapSearchRow)
}

/** 분할 검색의 전체 매칭 수 — "더 보기" 여부 판단용. */
export function countMessageMatches(
  db: Database,
  q: string,
  opts: MessageSearchOpts = {},
): number {
  const { where, params } = buildMessageSearchFilter(q, opts)
  const sql = `SELECT COUNT(*) AS c FROM session_messages_fts WHERE ${where.join(' AND ')}`
  const row = db.query(sql).get(...(params as any[])) as { c: number }
  return row.c
}

export interface MessageExpandRow {
  messageId: string
  role: string
  turnIndex: number
  ts: number
  text: string
}

/** 특정 메시지의 앞뒤 n턴 원문을 반환한다. */
export function expandMessage(db: Database, messageId: string, n = 3): { center: MessageExpandRow | null; rows: MessageExpandRow[] } {
  const center = db
    .query(
      `SELECT message_id AS m, role AS r, turn_index AS ti, ts AS t, text AS tx
       FROM session_messages_fts WHERE message_id = ?`,
    )
    .get(messageId) as { m: string; r: string; ti: number; t: number; tx: string } | undefined
  if (!center) return { center: null, rows: [] }

  const span = Math.max(0, Math.min(20, n))
  const rows = db
    .query(
      `SELECT message_id AS m, role AS r, turn_index AS ti, ts AS t, text AS tx
       FROM session_messages_fts
       WHERE session_id = (SELECT session_id FROM session_messages_fts WHERE message_id = ?)
         AND turn_index BETWEEN ? AND ?
       ORDER BY turn_index ASC`,
    )
    .all(messageId, center.ti - span, center.ti + span) as Array<{ m: string; r: string; ti: number; t: number; tx: string }>

  const mapped: MessageExpandRow[] = rows.map((row) => ({
    messageId: row.m,
    role: row.r,
    turnIndex: row.ti,
    ts: row.t,
    text: row.tx,
  }))
  return {
    center: {
      messageId: center.m,
      role: center.r,
      turnIndex: center.ti,
      ts: center.t,
      text: center.tx,
    },
    rows: mapped,
  }
}

/** FTS5 MATCH 인자로 안전하게 변환. `*` 와일드카드(prefix) 지원. */
function buildFtsQuery(q: string): string {
  const rawTokens = q.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0)
  if (rawTokens.length === 0) return '""'
  if (rawTokens.length === 1 && rawTokens[0] === '*') return '*'
  const tokens = rawTokens.map((t) => {
    if (t === '*') return null
    const isPrefix = t.endsWith('*') && t.length > 1
    const core = isPrefix ? t.slice(0, -1) : t
    const cleaned = core.replace(/[^\p{L}\p{N}_\-]/gu, '').trim()
    if (!cleaned) return null
    if (isPrefix) return `${cleaned.replace(/"/g, '""')}*`
    return `"${cleaned.replace(/"/g, '""')}"`
  }).filter((t): t is string => !!t)
  if (tokens.length === 0) return '""'
  return tokens.join(' AND ')
}
