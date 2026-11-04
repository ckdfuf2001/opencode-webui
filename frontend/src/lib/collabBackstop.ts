/**
 * 백스톱 저장 판정 (순수 함수).
 *
 * Y.Doc 변경을 직접 구독하는 백스톱은 lib write-back 경로와 무관하게 동작하므로,
 * lib 트리거가 묶였을 때의 폴백이다. 중복 저장을 피하기 위해 마지막 성공 저장
 * 바이트(latestSavedRef)와 비교해 같으면 건너뛴다.
 *
 * ABA: 다른 참가자가 그사이 저장하면 디스크는 바뀌었지만 내 문서가 예전
 * 저장본과 같은 바이트로 돌아올 수 있다. 이때 바이트 비교만으로는 유실된다.
 * 서버 해시(baseHashRef)가 내가 마지막으로 저장한 해시와 다르면 스냅샷을
 * 버리고 무조건 저장한다 (디스크 ETag 대조).
 */
export interface BackstopSaveInput {
  /** 마지막 성공 저장 바이트 (없으면 null). */
  snap: Uint8Array | null
  /** 이번에 저장하려는 바이트. */
  bytes: Uint8Array
  /** 마지막 성공 저장의 서버 해시 (없으면 null). */
  mineHash: string | null
  /** 현재 알려진 서버 디스크 해시 (없으면 null). */
  serverHash: string | null
}

export interface BackstopSaveDecision {
  action: 'save' | 'skip-duplicate'
  /** true면 ABA(서버 해시 불일치)로 스냅샷을 버린 것이다. */
  aba: boolean
}

export function decideBackstopSave(input: BackstopSaveInput): BackstopSaveDecision {
  let snap = input.snap
  // ABA: 버릴 스냅샷이 있고 서버 해시가 내 마지막 저장과 다르면(다른 사람이 저장),
  // 스냅샷을 버리고 무조건 저장한다. 스냅샷이 원래 없으면 aba가 아니다.
  const aba = snap != null && input.mineHash != null && input.serverHash != null && input.serverHash !== input.mineHash
  if (aba) snap = null
  if (snap && snap.length === input.bytes.length && snap.every((v, i) => v === input.bytes[i])) {
    return { action: 'skip-duplicate', aba }
  }
  return { action: 'save', aba }
}
