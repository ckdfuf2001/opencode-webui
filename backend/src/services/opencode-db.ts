import { Database } from 'bun:sqlite'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { existsSync } from 'fs'
import { logger } from '../utils/logger'
import { ENV, getWorkspacePath } from '@opencode-webui/shared'

const execFileAsync = promisify(execFile)

let cachedDbPath: string | null = null

function resolveOpenCodeBin(): string | null {
  const configured = (ENV.OPENCODE.BIN || '').trim()
  if (configured) {
    if (path.isAbsolute(configured) && existsSync(configured)) return configured
    const configuredExe = existsSync(configured) ? configured : null
    if (configuredExe) return configuredExe
  }
  for (const root of [path.join(process.cwd(), 'bin'), path.join(getWorkspacePath(), 'bin')]) {
    const exe = path.join(root, 'opencode.exe')
    if (existsSync(exe)) return exe
    const plain = path.join(root, 'opencode')
    if (existsSync(plain)) return plain
  }
  return 'opencode'
}

export async function getOpenCodeDbPath(): Promise<string | null> {
  // 테스트·컨테이너에서 직접 지정 가능 (session-message-db의 override와 동일).
  // 캐시하지 않는다 — env가 바뀌는 테스트에서 오염 방지 (stat 1회는 무시 가능).
  const override = (process.env.OPENCODE_DB_PATH || '').trim()
  if (override && existsSync(override)) return override
  if (cachedDbPath) return cachedDbPath
  const bin = resolveOpenCodeBin()
  if (!bin) return null
  try {
    const { stdout } = await execFileAsync(bin, ['db', 'path'], {
      timeout: 15_000,
      windowsHide: true,
    })
    const dbPath = (stdout?.trim().split(/\r?\n/)[0] ?? '').trim()
    if (dbPath && existsSync(dbPath)) {
      cachedDbPath = dbPath
      return dbPath
    }
    return null
  } catch (error) {
    logger.error('Failed to resolve OpenCode database path:', error)
    return null
  }
}

export interface TruncateResult {
  messagesRemoved: number
  partsRemoved: number
  eventsRemoved: number
  todoRemoved: number
  remainingMessages: number
}

export interface DeleteResult {
  messagesRemoved: number
  partsRemoved: number
  eventsRemoved: number
  remainingMessages: number
}

export async function truncateSessionMessages(
  sessionId: string,
  cursorMessageId: string,
): Promise<TruncateResult | null> {
  if (cursorMessageId.startsWith("optimistic_")) {
    logger.info(`Truncate: optimistic cursor ${cursorMessageId} — skipping DB, treated as success`)
    return { messagesRemoved: 0, partsRemoved: 0, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 0 }
  }
  const dbPath = await getOpenCodeDbPath()
  if (!dbPath) {
    logger.warn(`Truncate: opencode DB not found for session ${sessionId} — treated as success`)
    return { messagesRemoved: 0, partsRemoved: 0, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 0 }
  }

  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const cursor = db
      .query('SELECT time_created FROM message WHERE session_id = ? AND id = ?')
      .get(sessionId, cursorMessageId) as { time_created: number } | null
    if (!cursor) {
      logger.warn(`Truncate: cursor message ${cursorMessageId} not found in session ${sessionId} — treated as idempotent success`)
      const remaining = db.query('SELECT id FROM message WHERE session_id = ?').all(sessionId) as { id: string }[]
      return { messagesRemoved: 0, partsRemoved: 0, eventsRemoved: 0, todoRemoved: 0, remainingMessages: remaining.length }
    }
    const cursorTime = cursor.time_created

    db.exec('BEGIN IMMEDIATE')
    try {
      const messageIds = db
        .query<{ id: string }, [string, number]>(
          'SELECT id FROM message WHERE session_id = ? AND time_created >= ?',
        )
        .all(sessionId, cursorTime)
      const ids = messageIds.map((r) => r.id)

      let messagesRemoved = 0
      let partsRemoved = 0
      let todoRemoved = 0

      if (ids.length > 0) {
        const partResult = db
          .query<{ changes: number }, string[]>(
            'DELETE FROM part WHERE message_id IN (SELECT value FROM json_each(?))',
          )
          .run(JSON.stringify(ids))
        partsRemoved = Number(partResult.changes ?? 0)

        const msgResult = db
          .query<{ changes: number }, string[]>(
            'DELETE FROM message WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))',
          )
          .run(sessionId, JSON.stringify(ids))
        messagesRemoved = Number(msgResult.changes ?? 0)
      }

      db.query('DELETE FROM session_input WHERE session_id = ?').run(sessionId)
      const todoResult = db
        .query<{ changes: number }, string>('DELETE FROM todo WHERE session_id = ?')
        .run(sessionId)
      todoRemoved = Number(todoResult.changes ?? 0)

      const remaining = db
        .query('SELECT data FROM message WHERE session_id = ?')
        .all(sessionId) as { data: string }[]

      recomputeSessionMeta(db, sessionId, cursorTime)

      db.exec('COMMIT')

      logger.info(
        `Truncated session ${sessionId} at message ${cursorMessageId}: removed ${messagesRemoved} messages, ${partsRemoved} parts, ${todoRemoved} todos`,
      )
      return {
        messagesRemoved,
        partsRemoved,
        eventsRemoved: 0,
        todoRemoved,
        remainingMessages: remaining.length,
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

/**
 * Recompute the session-level aggregate (cost, token counts, updated time)
 * from the currently remaining messages in the session.
 */
function recomputeSessionMeta(db: Database, sessionId: string, fallbackTime: number) {
  const remaining = db
    .query('SELECT data FROM message WHERE session_id = ?')
    .all(sessionId) as { data: string }[]

  let cost = 0
  let tokensInput = 0
  let tokensOutput = 0
  let tokensReasoning = 0
  let tokensCacheRead = 0
  let tokensCacheWrite = 0
  let lastUpdated = fallbackTime
  for (const row of remaining) {
    try {
      const data = JSON.parse(row.data) as {
        cost?: number
        tokens?: {
          input?: number
          output?: number
          reasoning?: number
          cache?: { read?: number; write?: number }
        }
        time?: { created?: number }
      }
      if (typeof data.cost === 'number') cost += data.cost
      const t = data.tokens
      if (t) {
        tokensInput += t.input ?? 0
        tokensOutput += t.output ?? 0
        tokensReasoning += t.reasoning ?? 0
        tokensCacheRead += t.cache?.read ?? 0
        tokensCacheWrite += t.cache?.write ?? 0
      }
      if (data.time?.created) lastUpdated = Math.max(lastUpdated, data.time.created)
    } catch {
      // ignore malformed message data
    }
  }

  db.query(
    `UPDATE session
     SET cost = ?, tokens_input = ?, tokens_output = ?, tokens_reasoning = ?,
         tokens_cache_read = ?, tokens_cache_write = ?, time_updated = ?
     WHERE id = ?`,
  ).run(cost, tokensInput, tokensOutput, tokensReasoning, tokensCacheRead, tokensCacheWrite, lastUpdated, sessionId)
}

/**
 * Delete exactly one message plus its own parts — no cascade to children.
 * reasoning-heal 전용: mismatch로 거부된 실패 턴의 찌꺼기(error stub)만
 * 잘라낼 때 쓴다. 자식이 있으면 null (연쇄 삭제로 멀쩡한 턴까지 날아가는 것 방지).
 * user 메시지는 절대 건드리지 않는다 — 호출자가 보장할 것 (heal은 assistant+error만).
 */
export async function deleteSingleChildlessMessage(
  sessionId: string,
  messageId: string,
): Promise<DeleteResult | null> {
  const dbPath = await getOpenCodeDbPath()
  if (!dbPath) return null

  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const target = db
      .query('SELECT id FROM message WHERE session_id = ? AND id = ?')
      .get(sessionId, messageId) as { id: string } | null
    if (!target) {
      logger.warn(`DeleteSingle: target message ${messageId} not found in session ${sessionId}`)
      return null
    }

    const allMsgs = db
      .query<{ id: string; data: string }, string>('SELECT id, data FROM message WHERE session_id = ?')
      .all(sessionId)
    for (const row of allMsgs) {
      try {
        const parsed = JSON.parse(row.data) as { parentID?: string }
        if (parsed.parentID === messageId) {
          logger.warn(`DeleteSingle: message ${messageId} has child ${row.id} — refusing (no cascade)`)
          return null
        }
      } catch {
        // ignore malformed data
      }
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      const partResult = db
        .query<{ changes: number }, string>('DELETE FROM part WHERE message_id = ?')
        .run(messageId)
      const msgResult = db
        .query<{ changes: number }, [string, string]>('DELETE FROM message WHERE session_id = ? AND id = ?')
        .run(sessionId, messageId)

      recomputeSessionMeta(db, sessionId, Date.now())

      const remaining = db
        .query('SELECT id FROM message WHERE session_id = ?')
        .all(sessionId) as { id: string }[]

      db.exec('COMMIT')

      logger.info(
        `Deleted single message ${messageId} in session ${sessionId}: removed ${Number(msgResult.changes ?? 0)} messages, ${Number(partResult.changes ?? 0)} parts`,
      )
      return {
        messagesRemoved: Number(msgResult.changes ?? 0),
        partsRemoved: Number(partResult.changes ?? 0),
        eventsRemoved: 0,
        remainingMessages: remaining.length,
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

export interface StripResult {
  partsRemoved: number
  messagesAffected: number
}

/**
 * reasoning part 단위 수술: 현재 모델과 다른 턴이 남긴 reasoning만 지운다.
 * 크로스모델 encrypted_content 400의 진짜 해법 — 메시지/턴을 통째로 버리지
 * 않으므로 text·tool 결과는 그대로 남고, 자식 검사에 막히지도 않는다.
 * 실DB 실측: reasoning part의 metadata.openai 안에 {itemId, reasoningEncryptedContent}
 * blob이 들어 있어 part 행 삭제가 곧 blob 제거다. 다른 part의 metadata는
 * itemId뿐이라(19k+ 정상 턴이 매일 replay) 남겨둬도 안전하다.
 *
 * 최신 턴은 반드시 제외한다: interleaved thinking을 쓰는 provider는 tool_use 앞의
 * thinking 블록을 요구하므로, 최신 턴은 기존 turn 단위 삭제(truncate)로 처리한다.
 * 경계 = 세션의 최신 user 메시지 시각 (그 턴 전체를 통째로 보존).
 */
export async function stripReasoningParts(
  sessionId: string,
  keep: { providerID: string; modelID: string },
): Promise<StripResult | null> {
  const dbPath = await getOpenCodeDbPath()
  if (!dbPath) return null

  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const boundary = db
      .query(
        `SELECT MAX(time_created) AS t FROM message
         WHERE session_id = ? AND json_extract(data,'$.role') = 'user'`,
      )
      .get(sessionId) as { t: number | null } | null
    const cutoff = boundary?.t ?? 0

    db.exec('BEGIN IMMEDIATE')
    try {
      const affected = db
        .query<{ n: number }, [string, number, string, string]>(
          `SELECT COUNT(DISTINCT p.message_id) AS n
           FROM part p JOIN message m ON m.id = p.message_id
           WHERE m.session_id = ?
             AND m.time_created < ?
             AND json_extract(m.data,'$.role') = 'assistant'
             AND (json_extract(m.data,'$.providerID') != ? OR json_extract(m.data,'$.modelID') != ?)
             AND json_extract(p.data,'$.type') = 'reasoning'`,
        )
        .get(sessionId, cutoff, keep.providerID, keep.modelID) as { n: number }
      const del = db
        .query<{ changes: number }, [string, number, string, string]>(
          `DELETE FROM part
           WHERE message_id IN (
             SELECT m.id FROM message m
             WHERE m.session_id = ?
               AND m.time_created < ?
               AND json_extract(m.data,'$.role') = 'assistant'
               AND (json_extract(m.data,'$.providerID') != ? OR json_extract(m.data,'$.modelID') != ?)
           )
           AND json_extract(data,'$.type') = 'reasoning'`,
        )
        .run(sessionId, cutoff, keep.providerID, keep.modelID)

      db.exec('COMMIT')

      const partsRemoved = Number(del.changes ?? 0)
      logger.info(
        `Stripped ${partsRemoved} foreign reasoning part(s) in ${Number(affected?.n ?? 0)} message(s) of session ${sessionId} (kept ${keep.providerID}/${keep.modelID}, cutoff ${cutoff})`,
      )
      return { partsRemoved, messagesAffected: Number(affected?.n ?? 0) }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

/**
 * Delete a single message plus its descendant subtree (the message's own turn,
 * e.g. the user message and the assistant replies it produced) while keeping
 * later independent turns intact. Unlike truncate, this does not remove every
 * message after the cursor — only the message and its children.
 */
export async function deleteSessionMessage(
  sessionId: string,
  messageId: string,
): Promise<DeleteResult | null> {
  const dbPath = await getOpenCodeDbPath()
  if (!dbPath) return null

  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const target = db
      .query('SELECT id FROM message WHERE session_id = ? AND id = ?')
      .get(sessionId, messageId) as { id: string } | null
    if (!target) {
      logger.warn(`Delete: target message ${messageId} not found in session ${sessionId}`)
      return null
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      // opencode message table has no parent_id column - parentID is stored inside data JSON (assistant messages have data.parentID)
      const allMsgs = db
        .query<{ id: string; data: string }, string>('SELECT id, data FROM message WHERE session_id = ?')
        .all(sessionId)
      const childrenByParent = new Map<string, string[]>()
      for (const row of allMsgs) {
        try {
          const parsed = JSON.parse(row.data) as { parentID?: string }
          if (parsed.parentID) {
            const list = childrenByParent.get(parsed.parentID)
            if (list) list.push(row.id)
            else childrenByParent.set(parsed.parentID, [row.id])
          }
        } catch {
          // ignore malformed data
        }
      }
      const ids = new Set<string>([messageId])
      let frontier = [messageId]
      while (frontier.length > 0) {
        const next: string[] = []
        for (const pid of frontier) {
          const children = childrenByParent.get(pid) ?? []
          for (const cid of children) {
            if (!ids.has(cid)) {
              ids.add(cid)
              next.push(cid)
            }
          }
        }
        frontier = next
      }
      const idList = [...ids]

      let partsRemoved = 0
      let messagesRemoved = 0
      if (idList.length > 0) {
        const partResult = db
          .query<{ changes: number }, string[]>(
            'DELETE FROM part WHERE message_id IN (SELECT value FROM json_each(?))',
          )
          .run(JSON.stringify(idList))
        partsRemoved = Number(partResult.changes ?? 0)

        const msgResult = db
          .query<{ changes: number }, string[]>(
            'DELETE FROM message WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))',
          )
          .run(sessionId, JSON.stringify(idList))
        messagesRemoved = Number(msgResult.changes ?? 0)
      }

      recomputeSessionMeta(db, sessionId, Date.now())

      const remaining = db
        .query('SELECT id FROM message WHERE session_id = ?')
        .all(sessionId) as { id: string }[]

      db.exec('COMMIT')

      logger.info(
        `Deleted turn of message ${messageId} in session ${sessionId}: removed ${messagesRemoved} messages, ${partsRemoved} parts`,
      )
      return {
        messagesRemoved,
        partsRemoved,
        eventsRemoved: 0,
        remainingMessages: remaining.length,
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}