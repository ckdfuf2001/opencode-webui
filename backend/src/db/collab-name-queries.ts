import type { Database } from 'bun:sqlite'

/**
 * 공동편집 자동 이름 발급 (user1, user2, …).
 * 카운터는 SQLite에 저장해서 백엔드 재시작해도 이어진다.
 * db가 없으면(hermetic 테스트) 프로세스 내 카운터로 폴백한다.
 */
let memNext = 1

export function issueCollabName(db?: Database | null): string {
  if (!db) {
    const n = memNext
    memNext += 1
    return `user${n}`
  }
  try {
    const row = db.query('SELECT next FROM collab_name_seq WHERE id = 1').get() as { next: number } | null
    const n = row && Number.isFinite(row.next) && row.next >= 1 ? Math.floor(row.next) : 1
    db.query('UPDATE collab_name_seq SET next = ? WHERE id = 1').run(n + 1)
    return `user${n}`
  } catch {
    const n = memNext
    memNext += 1
    return `user${n}`
  }
}
