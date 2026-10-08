import type { Database } from 'bun:sqlite'

export type NotifyScope = 'session' | 'repo'

export interface NotifyOverride {
  scope: NotifyScope
  target: string
  pushEnabled: boolean | null
  soundEnabled: boolean | null
  soundOnCancelEnabled: boolean | null
  skillAutoEnabled: boolean | null
  skillReviewEnabled: boolean | null
  updatedAt: number
}

export interface NotifyOverridePatch {
  pushEnabled?: boolean | null
  soundEnabled?: boolean | null
  soundOnCancelEnabled?: boolean | null
  skillAutoEnabled?: boolean | null
  skillReviewEnabled?: boolean | null
}

interface NotifyOverrideRow {
  scope: string
  target: string
  push_enabled: number | null
  sound_enabled: number | null
  sound_on_cancel_enabled: number | null
  skill_auto_enabled: number | null
  skill_review_enabled: number | null
  updated_at: number
}

const toBool = (v: number | null): boolean | null =>
  v == null ? null : v !== 0

function rowToOverride(row: NotifyOverrideRow): NotifyOverride {
  return {
    scope: row.scope as NotifyScope,
    target: row.target,
    pushEnabled: toBool(row.push_enabled),
    soundEnabled: toBool(row.sound_enabled),
    soundOnCancelEnabled: toBool(row.sound_on_cancel_enabled),
    skillAutoEnabled: toBool(row.skill_auto_enabled),
    skillReviewEnabled: toBool(row.skill_review_enabled),
    updatedAt: row.updated_at,
  }
}

const toInt = (v: boolean | null | undefined): number | null =>
  v == null ? null : (v ? 1 : 0)

export function listNotifyOverrides(db: Database): NotifyOverride[] {
  const rows = db
    .query('SELECT scope, target, push_enabled, sound_enabled, sound_on_cancel_enabled, skill_auto_enabled, skill_review_enabled, updated_at FROM notify_overrides')
    .all() as NotifyOverrideRow[]
  return rows.map(rowToOverride)
}

export function getNotifyOverride(db: Database, scope: NotifyScope, target: string): NotifyOverride | null {
  const row = db
    .query('SELECT scope, target, push_enabled, sound_enabled, sound_on_cancel_enabled, skill_auto_enabled, skill_review_enabled, updated_at FROM notify_overrides WHERE scope = ? AND target = ?')
    .get(scope, target) as NotifyOverrideRow | undefined
  return row ? rowToOverride(row) : null
}

const OVERRIDE_FIELDS = [
  'push_enabled',
  'sound_enabled',
  'sound_on_cancel_enabled',
  'skill_auto_enabled',
  'skill_review_enabled',
] as const

const PATCH_KEYS: Array<keyof NotifyOverridePatch> = [
  'pushEnabled',
  'soundEnabled',
  'soundOnCancelEnabled',
  'skillAutoEnabled',
  'skillReviewEnabled',
]

export function upsertNotifyOverride(
  db: Database,
  scope: NotifyScope,
  target: string,
  patch: NotifyOverridePatch,
): NotifyOverride | null {
  const sets: string[] = []
  const vals: Array<number | null> = []
  for (let i = 0; i < PATCH_KEYS.length; i++) {
    const key = PATCH_KEYS[i]!
    if (patch[key] !== undefined) {
      sets.push(`${OVERRIDE_FIELDS[i]} = ?`)
      vals.push(toInt(patch[key]))
    }
  }
  if (sets.length === 0) return getNotifyOverride(db, scope, target)
  const now = Date.now()
  db.query(
    `INSERT INTO notify_overrides (scope, target, ${OVERRIDE_FIELDS.filter((_, i) => patch[PATCH_KEYS[i]!] !== undefined).join(', ')}, updated_at)
     VALUES (?, ?, ${vals.map(() => '?').join(', ')}, ?)
     ON CONFLICT(scope, target) DO UPDATE SET ${sets.join(', ')}, updated_at = excluded.updated_at`,
  ).run(scope, target, ...vals, now)
  return getNotifyOverride(db, scope, target)
}

export function deleteNotifyOverride(db: Database, scope: NotifyScope, target: string): void {
  db.query('DELETE FROM notify_overrides WHERE scope = ? AND target = ?').run(scope, target)
}

/** 새 전송 신호 — 직접전송(DELETE /cancelled 경유)·큐 enqueue에서 기록. */
export function touchNotifySend(db: Database, sessionId: string, at = Date.now()): void {
  db.query(
    `INSERT INTO notify_state (session_id, last_send_at, last_abort_at)
     VALUES (?, ?, 0)
     ON CONFLICT(session_id) DO UPDATE SET last_send_at = excluded.last_send_at`,
  ).run(sessionId, at)
}

/** 중단 보고 — useAbortSession에서 fire-and-forget으로 기록. */
export function touchNotifyAbort(db: Database, sessionId: string, at = Date.now()): void {
  db.query(
    `INSERT INTO notify_state (session_id, last_send_at, last_abort_at)
     VALUES (?, 0, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_abort_at = excluded.last_abort_at`,
  ).run(sessionId, at)
}

export function getNotifyState(db: Database, sessionId: string): { lastSendAt: number; lastAbortAt: number } {
  const row = db
    .query('SELECT last_send_at, last_abort_at FROM notify_state WHERE session_id = ?')
    .get(sessionId) as { last_send_at: number; last_abort_at: number } | undefined
  return { lastSendAt: row?.last_send_at ?? 0, lastAbortAt: row?.last_abort_at ?? 0 }
}
