import { describe, it, expect } from 'vitest'
import { decideBackstopSave } from '../src/lib/collabBackstop'

/**
 * 백스톱 저장 판정 단위 테스트 (ABA).
 *
 * 배경: lib write-back이 묶이면 Y.Doc 구독 백스톱이 폴백 저장을 맡는다.
 * 중복 저장을 피하려고 마지막 성공 저장 바이트와 비교해 같으면 건너뛰는데,
 * 다른 사람이 그사이 저장한 뒤 내 문서가 예전 저장본과 같은 바이트로 돌아오면
 * (ABA) 바이트 비교만으로는 유실을 막지 못한다. 서버 디스크 해시(baseHash)와
 * 내 마지막 저장 해시를 대조해 다르면 스냅샷을 버리고 저장해야 한다.
 *
 * E2E로는 재현이 결정적이지 않다 (원격 저장→내 revert 사이에
 * lib write-back이 끼어들어 스냅샷을 갱신해 버리면 ABA 분기가 실행되지 않는다).
 * 대신 여기서 결정 로직의 분기를 전부 고정한다.
 */
const u8 = (...xs: number[]): Uint8Array => new Uint8Array(xs)
const X1 = u8(1, 2, 3)
const X1COPY = u8(1, 2, 3)
const X2 = u8(1, 2, 4)
const EMPTY = u8()

describe('decideBackstopSave', () => {
  it('같은 바이트 + 같은 해시 → 건너뛴다 (중복 저장 방지)', () => {
    expect(decideBackstopSave({ snap: X1, bytes: X1COPY, mineHash: 'H1', serverHash: 'H1' })).toEqual({
      action: 'skip-duplicate',
      aba: false,
    })
  })

  it('같은 바이트 + 바뀐 서버 해시 → 저장한다 (ABA)', () => {
    expect(decideBackstopSave({ snap: X1, bytes: X1COPY, mineHash: 'H1', serverHash: 'H2' })).toEqual({
      action: 'save',
      aba: true,
    })
  })

  it('다른 바이트 → 저장한다 (해시 무관)', () => {
    expect(decideBackstopSave({ snap: X1, bytes: X2, mineHash: 'H1', serverHash: 'H1' })).toEqual({
      action: 'save',
      aba: false,
    })
    expect(decideBackstopSave({ snap: X1, bytes: X2, mineHash: 'H1', serverHash: 'H2' })).toEqual({
      action: 'save',
      aba: true,
    })
  })

  it('스냅샷 없음 → 저장한다 (aba 아님)', () => {
    expect(decideBackstopSave({ snap: null, bytes: X1, mineHash: 'H1', serverHash: 'H2' })).toEqual({
      action: 'save',
      aba: false,
    })
  })

  it('해시 모름 → 바이트 비교만 한다', () => {
    expect(decideBackstopSave({ snap: X1, bytes: X1COPY, mineHash: null, serverHash: 'H9' })).toEqual({
      action: 'skip-duplicate',
      aba: false,
    })
    expect(decideBackstopSave({ snap: X1, bytes: X1COPY, mineHash: 'H1', serverHash: null })).toEqual({
      action: 'skip-duplicate',
      aba: false,
    })
    expect(decideBackstopSave({ snap: X1, bytes: X2, mineHash: null, serverHash: null })).toEqual({
      action: 'save',
      aba: false,
    })
  })

  it('빈 바이트는 저장 경로로 보낸다 (호출자가 별도 처리)', () => {
    // PptxViewer는 bytes.length === 0 을 먼저 걸러낸다. 결정 함수는 그대로 save를 낸다.
    expect(decideBackstopSave({ snap: X1, bytes: EMPTY, mineHash: 'H1', serverHash: 'H1' }).action).toBe('save')
  })
})
