import { describe, it, expect } from 'vitest'
import { decideSaveIntent, type OwnerState } from '../src/lib/collabSaveIntent'

/**
 * B3 회귀: owner가 아닌 사람이 수동 저장하면 "Save failed — staying in edit mode"이 뜨고
 * 그 뒤에 성공 토스트까지 따라온다.
 *
 * 원인: persistBytes가 owner 여부를 미리 보지 않고 곧바로 저장 API를 불렀다.
 * 서버는 owner만 저장하므로 non-owner는 `denied`를 받고,
 * 저장 리스너(PptxViewer.tsx:512-513)가 `throw new Error('Save rejected')`로 번져
 * officeSaveDone ok:false → "Save failed — staying in edit mode"이 표시됐다.
 *
 * 수정 전 게이트(항상 persist)로 이 테스트를 돌리면 owner가 아닌데 persist가 반환되어 실패한다.
 */
describe('collabSaveIntent (B3)', () => {
  const decide = (owner: OwnerState, synced = true) => decideSaveIntent({ owner, synced })

  it('owner는 실제로 저장한다', () => {
    expect(decide('self')).toEqual({ kind: 'persist', reason: 'owner' })
  })

  it('owner가 아니면 API 호출 없이 성공 처리한다 (B3 핵심)', () => {
    expect(decide('other')).toEqual({ kind: 'delegated', reason: 'other-owner-synced' })
  })

  it('owner 미확정(선출 중)은 meta를 기다린 뒤 재판정한다', () => {
    // 'unknown'을 곧바로 'other'로 보면 승계 직후에 잘못된 성공/실패가 나온다.
    expect(decide('unknown')).toEqual({ kind: 'await-meta', reason: 'owner-unknown' })
  })

  it('owner가 아니고 아직 synced가 아니면 meta를 기다린다', () => {
    // 내 변경이 공유 doc에 반영됐다는 보장이 없다. 조용한 성공 처리 금지.
    expect(decide('other', false)).toEqual({ kind: 'await-meta', reason: 'other-owner-not-synced' })
  })

  it('owner인데 미동기여도 저장 시도한다 (서버가 not_seeded로 판정한다)', () => {
    expect(decide('self', false)).toEqual({ kind: 'persist', reason: 'owner' })
  })
})
