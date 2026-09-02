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