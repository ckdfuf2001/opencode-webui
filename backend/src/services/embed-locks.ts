/**
 * C5-3: 첨부 편집 잠금 (path+part 단위, C4 개체 락과 같은 임대 모델).
 *
 * - 방 바깥 키이므로 방/연결과 무관하게 만료(TTL)로 해제된다.
 *   WS close 시 별도 해제는 없다 — 갱신 중단 시 TTL 만료가 이를 대신한다.
 *   (close/done 때는 클라이언트가 명시 해제한다.)
 * - 같은 token이면 갱신(lease 연장)하고, 다른 holder면 locked + holderName을 돌려준다.
 */
import { randomUUID } from 'node:crypto'

/** 임대 기간. 사람이 편집하는 단위라 C4(10초)보다 넉넉하게 둔다. */
export const EMBED_LOCK_TTL_MS = 60_000

export interface EmbedLock {
  lockId: string
  holder: string
  token: string
  expiresAt: number
}

const locks = new Map<string, EmbedLock>()

export function embedLockKey(absPath: string, part: string): string {
  return `${absPath}\n${part}`
}

/** 표시용 이름 살균 (제어문자 제거·앞뒤 공백 제거·40자). */
export function sanitizeHolderName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  // eslint-disable-next-line no-control-regex -- 살균이 목적이다
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40)
  return cleaned || 'user'
}

export function sweepEmbedLocks(now: number = Date.now()): number {
  let n = 0
  for (const [k, v] of locks) {
    if (v.expiresAt <= now) {
      locks.delete(k)
      n++
    }
  }
  return n
}

export function acquireEmbedLock(
  absPath: string,
  part: string,
  holder: string,
  token: string,
  opts?: { lockId?: string; ttlMs?: number; now?: number },
):
  | { ok: true; lockId: string; expiresAt: number; renewed: boolean }
  | { ok: false; code: 'locked'; holderName: string; expiresAt: number } {
  const now = opts?.now ?? Date.now()
  sweepEmbedLocks(now)
  const key = embedLockKey(absPath, part)
  const cur = locks.get(key)
  const ttl = opts?.ttlMs ?? EMBED_LOCK_TTL_MS
  if (cur) {
    if (cur.token === token && (!opts?.lockId || opts.lockId === cur.lockId)) {
      cur.expiresAt = now + ttl
      return { ok: true, lockId: cur.lockId, expiresAt: cur.expiresAt, renewed: true }
    }
    return { ok: false, code: 'locked', holderName: cur.holder, expiresAt: cur.expiresAt }
  }
  const lockId = randomUUID()
  locks.set(key, { lockId, holder: sanitizeHolderName(holder), token, expiresAt: now + ttl })
  return { ok: true, lockId, expiresAt: now + ttl, renewed: false }
}

export function releaseEmbedLock(
  absPath: string,
  part: string,
  lockId: string,
  token?: string,
): { ok: true } | { ok: false; code: 'no_lock' | 'not_holder' } {
  sweepEmbedLocks()
  const key = embedLockKey(absPath, part)
  const cur = locks.get(key)
  if (!cur) return { ok: false, code: 'no_lock' }
  if (cur.lockId !== lockId) return { ok: false, code: 'not_holder' }
  if (token !== undefined && cur.token !== token) return { ok: false, code: 'not_holder' }
  locks.delete(key)
  return { ok: true }
}

export function getEmbedLock(absPath: string, part: string): EmbedLock | null {
  sweepEmbedLocks()
  return locks.get(embedLockKey(absPath, part)) ?? null
}

/** 테스트용 리셋. */
export function clearEmbedLocksForTest(): void {
  locks.clear()
}
