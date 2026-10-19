export type OwnerState = 'unknown' | 'self' | 'other'

export type SaveIntent =
  | { kind: 'persist'; reason: 'owner' }
  | { kind: 'delegated'; reason: 'other-owner-synced' }
  | { kind: 'await-meta'; reason: 'owner-unknown' | 'other-owner-not-synced' }

/**
 * B3: 수동 저장을 누르기 전에 "내가 디스크에 쓸 수 있는가"를 먼저 판정한다.
 *
 * 판정이 없으면 저장 API를 곧바로 불르고, 서버가 non-owner를 `denied`로 돌려보내면서
 * "Save failed — staying in edit mode"이 떴다(서버가 owner만 쓰는 규칙은 D05로 고정).
 *
 * owner 미확정('unknown')과 '남이 owner'는 구분해야 한다. 구분 없이 'other'로 보면
 * 승계 직후의 저장에서 잘못된 결과를 토스트한다.
 */
export function decideSaveIntent(input: { owner: OwnerState; synced: boolean }): SaveIntent {
  if (input.owner === 'unknown') return { kind: 'await-meta', reason: 'owner-unknown' }
  if (input.owner === 'self') return { kind: 'persist', reason: 'owner' }
  return input.synced
    ? { kind: 'delegated', reason: 'other-owner-synced' }
    : { kind: 'await-meta', reason: 'other-owner-not-synced' }
}
