/** 레포 카드 순서 (개인별, localStorage — 서버에 저장 안 함) */

export const REPO_ORDER_KEY = 'repo-order:v1'

export function loadRepoOrder(): number[] {
  try {
    const raw = localStorage.getItem(REPO_ORDER_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

export function saveRepoOrder(ids: number[]): void {
  try {
    localStorage.setItem(REPO_ORDER_KEY, JSON.stringify(ids))
  } catch {}
}

/** 저장된 순서 우선, 목록에 새로 생긴 id는 뒤에 (서버 순서 유지) */
export function applySavedOrder<T extends { id: number }>(list: T[], order: number[]): T[] {
  if (order.length === 0) return list
  const pos = new Map(order.map((id, i) => [id, i]))
  const ranked = list.filter((r) => pos.has(r.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
  const rankedIds = new Set(ranked.map((r) => r.id))
  return [...ranked, ...list.filter((r) => !rankedIds.has(r.id))]
}
