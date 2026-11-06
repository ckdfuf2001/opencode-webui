/**
 * PPTX OLE 도형 더블클릭 → 첨부 열기 라우팅용 히트테스트 (순수 함수).
 * - OleAttachmentOverlay의 posMap(컨테이너 상대 rect)과 dblclick 좌표로
 *   어떤 임베딩 위를 눌렀는지 찾는다.
 * - lib 캔버스는 OLE dblclick이 no-op이라 컨테이너 캡처 리스너에서 쓴다.
 */
export interface OleHitRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 점을 포함하는 rect 중 가장 좁은 것의 partName을 돌려준다 (없으면 null).
 * - 경계 포함, 너비/높이 0 이하는 제외.
 * - 겹치면 좁은 쪽(모서리 아이콘 영역 등)이 이긴다.
 */
export function findOleEntryAtPoint(
  rects: Record<string, OleHitRect>,
  x: number,
  y: number,
): string | null {
  let best: string | null = null
  let bestArea = Infinity
  for (const [part, r] of Object.entries(rects)) {
    if (!r || r.w <= 0 || r.h <= 0) continue
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      const area = r.w * r.h
      if (area < bestArea) {
        bestArea = area
        best = part
      }
    }
  }
  return best
}
