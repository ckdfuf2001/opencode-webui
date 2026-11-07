import { describe, it, expect } from 'vitest'
import { findOleEntryAtPoint } from '../src/lib/oleHitTest'

/**
 * PPTX OLE 도형 dblclick 라우팅 히트테스트 (순수).
 * - 컨테이너 상대 rect + 클릭 좌표로 임베딩 partName을 찾는다.
 * - lib dblclick이 OLE에 no-op이라 컨테이너 캡처에서 이 판정으로 연다.
 */
describe('findOleEntryAtPoint (pptx ole dblclick routing)', () => {
  const rects = {
    'ppt/embeddings/a.bin': { x: 10, y: 20, w: 100, h: 50 },
    'ppt/embeddings/b.bin': { x: 200, y: 20, w: 60, h: 60 },
  }

  it('rect 안이면 partName을 돌려준다', () => {
    expect(findOleEntryAtPoint(rects, 15, 25)).toBe('ppt/embeddings/a.bin')
    expect(findOleEntryAtPoint(rects, 210, 30)).toBe('ppt/embeddings/b.bin')
  })

  it('rect 밖이면 null이다', () => {
    expect(findOleEntryAtPoint(rects, 0, 0)).toBe(null)
    expect(findOleEntryAtPoint(rects, 150, 40)).toBe(null)
  })

  it('경계는 포함한다', () => {
    expect(findOleEntryAtPoint(rects, 10, 20)).toBe('ppt/embeddings/a.bin')
    expect(findOleEntryAtPoint(rects, 110, 70)).toBe('ppt/embeddings/a.bin')
  })

  it('너비/높이 0 이하는 제외한다', () => {
    const m = { ...rects, 'ppt/embeddings/z.bin': { x: 15, y: 25, w: 0, h: 0 } }
    expect(findOleEntryAtPoint(m, 15, 25)).toBe('ppt/embeddings/a.bin')
  })

  it('겹치면 좁은 rect가 이긴다', () => {
    const m = {
      'ppt/embeddings/big.bin': { x: 0, y: 0, w: 500, h: 500 },
      'ppt/embeddings/small.bin': { x: 10, y: 10, w: 20, h: 20 },
    }
    expect(findOleEntryAtPoint(m, 15, 15)).toBe('ppt/embeddings/small.bin')
    expect(findOleEntryAtPoint(m, 400, 400)).toBe('ppt/embeddings/big.bin')
  })

  it('빈 맵이면 null이다', () => {
    expect(findOleEntryAtPoint({}, 10, 10)).toBe(null)
  })

  it('padBottom이 있으면 rect 아래 캡션 영역도 잡는다', () => {
    // rect y=20 h=50 → 아래 70까지. 캡션은 그 아래 ~30px.
    expect(findOleEntryAtPoint(rects, 50, 85)).toBe(null)
    expect(findOleEntryAtPoint(rects, 50, 85, 32)).toBe('ppt/embeddings/a.bin')
    // 기본값(0)이면 기존 동작 그대로다.
    expect(findOleEntryAtPoint(rects, 50, 85, 0)).toBe(null)
  })

  it('padBottom 겹침은 원래 면적이 좁은 쪽이 이긴다', () => {
    const m = {
      'ppt/embeddings/wide.bin': { x: 0, y: 0, w: 200, h: 20 },
      'ppt/embeddings/narrow.bin': { x: 0, y: 25, w: 20, h: 20 },
    }
    // y=30: 위 rect의 캡션 패드이자 아래 rect의 본문 → 원래 면적이 좁은 아래쪽이 이긴다.
    expect(findOleEntryAtPoint(m, 10, 30, 32)).toBe('ppt/embeddings/narrow.bin')
    // x=100: 아래 rect 밖 → 위 rect의 캡션 패드만 걸린다.
    expect(findOleEntryAtPoint(m, 100, 30, 32)).toBe('ppt/embeddings/wide.bin')
  })
})
