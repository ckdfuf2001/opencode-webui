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
  const vals: Array<number | null> = []
  for (let i = 0; i < PATCH_KEYS.length; i++) {
    const key = PATCH_KEYS[i]!
    if (patch[key] !== undefined) {
      vals.push(toInt(patch[key]))
    }
  }
  if (vals.length === 0) return getNotifyOverride(db, scope, target)
  const now = Date.now()
  const insertCols = OVERRIDE_FIELDS.filter((_, i) => patch[PATCH_KEYS[i]!] !== undefined)
  // DO UPDATE SET은 excluded.* 참조 — INSERT 플레이스홀더와 개수를 맞추기 위함
  // (?를 쓰면 바인드 개수가 어긋나 500이 난다).
  const updateSets = insertCols.map((c) => `${c} = excluded.${c}`)
  db.query(
    `INSERT INTO notify_overrides (scope, target, ${insertCols.join(', ')}, updated_at)
     VALUES (?, ?, ${vals.map(() => '?').join(', ')}, ?)
     ON CONFLICT(scope, target) DO UPDATE SET ${updateSets.join(', ')}, updated_at = excluded.updated_at`,
  ).run(scope, target, ...vals, now)
  return getNotifyOverride(db, scope, target)
}

export function deleteNotifyOverride(db: Database, scope: NotifyScope, target: string): void {
  db.query('DELETE FROM notify_overrides WHERE scope = ? AND target = ?').run(scope, target)
}
