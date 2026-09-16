/** 턴 단위 선택 헬퍼 (검색 페이지·점프 다이얼로그 공용).
 *  user 메시지를 체크하면 다음 user 전까지의 assistant 응답까지 같이 선택된다.
 *  assistant는 낱개 토글. user 체크 해제는 그 턴 전체를 해제한다. */

/** 순서 리스트에서 user 인덱스 i의 턴 범위 [from, to] (to exclusive) */
export function turnRange(
  ids: string[],
  roles: (string | undefined)[],
  userIndex: number,
): { from: number; to: number } {
  let to = userIndex + 1
  while (to < ids.length && roles[to] !== 'user') to++
  return { from: userIndex, to }
}

export function toggleTurn(
  prev: Set<string>,
  ids: string[],
  roles: (string | undefined)[],
  index: number,
): Set<string> {
  const next = new Set(prev)
  const id = ids[index]
  if (!id) return next
  if (roles[index] === 'user') {
    const { from, to } = turnRange(ids, roles, index)
    const allOn = ids.slice(from, to).every((x) => next.has(x))
    for (let i = from; i < to; i++) {
      const k = ids[i]
      if (!k) continue
      if (allOn) next.delete(k)
      else next.add(k)
    }
    return next
  }
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
