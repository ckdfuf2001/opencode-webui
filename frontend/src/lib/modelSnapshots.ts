/**
 * F1-1: 새로고침 스냅샷 비교 (추가/유지/없어짐 분류).
 * 스냅샷에 있는데 이번 목록에 없으면 "없어진 모델"이다.
 */
export interface ModelSnapshotDiff {
  added: string[]
  kept: string[]
  removed: string[]
}

function uniqInOrder(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function classifyModelSnapshot(
  prevIds: string[],
  current: Array<{ id: string }>,
): ModelSnapshotDiff {
  const prev = uniqInOrder(prevIds)
  const cur = uniqInOrder(current.map((m) => m.id))
  const curSet = new Set(cur)
  const prevSet = new Set(prev)
  return {
    added: cur.filter((id) => !prevSet.has(id)),
    kept: prev.filter((id) => curSet.has(id)),
    removed: prev.filter((id) => !curSet.has(id)),
  }
}
