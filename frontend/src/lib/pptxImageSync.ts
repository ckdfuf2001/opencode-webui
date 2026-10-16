/**
 * lib(ppptx-react-viewer/ooxml-core)가 그림을 blob: URL로 만들면,
 * Y.Doc로 동기화될 때 joiner에게 죽은 문자열이 된다 (blob은 로컬 전용).
 * 증상: 먼저 들어간 사람에게만 이미지가 보이고, 편집 진입·늦은 합류자는 imageless.
 * 디스크 저장(getContent)은 zip에서 다시 읽어서 멀쩡하므로 렌더 문제다.
 *
 * 수정: PptxHandler.createImageUrl를 data: URL로 고정한다.
 * data: URL은 Y.Doc를 타고도 살아남고 새로고침에도 안전하다.
 * 대가: base64 +33% 메모리. blob 캐시·revoke 로직은 data:에 무해하다.
 */
import { PptxHandler } from 'ooxml-core/pptx'

const PATCH_KEY = '__opencodeImageDataUrlPatched'

function bytesToDataUrl(bytes: ArrayBuffer, mimeType: string): string {
  const uint8 = new Uint8Array(bytes)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

export function ensurePptxImagesSyncable(): void {
  try {
    const proto = (
      PptxHandler as unknown as { prototype?: Record<string | symbol, unknown> }
    )?.prototype
    if (!proto || typeof proto.createImageUrl !== 'function') return
    if ((proto as Record<symbol, unknown>)[Symbol.for(PATCH_KEY)]) return
    proto.createImageUrl = function (bytes: ArrayBuffer, mimeType: string): string {
      return bytesToDataUrl(bytes, mimeType)
    }
    ;(proto as Record<symbol, unknown>)[Symbol.for(PATCH_KEY)] = true
  } catch {
    // 패치 실패해도 뷰어는 뜬다 (이미지만 예전 동작).
  }
}

/** Y.Doc 슬라이드의 그림 데이터 상태 (E2E/디버그용, lib import 없이 Y API만). */
export function countPptxDocImages(doc: {
  getArray: (key: string) => {
    length: number
    get: (i: number) => {
      get: (key: string) => unknown
    }
  }
}): { pictures: number; withData: number; blobOnly: number } {
  const out = { pictures: 0, withData: 0, blobOnly: 0 }
  try {
    const arr = doc.getArray('pptx:slides')
    for (let i = 0; i < arr.length; i++) {
      let elems: { length: number; get: (j: number) => { get: (k: string) => unknown } }
      try {
        elems = arr.get(i).get('elements') as typeof elems
      } catch {
        continue
      }
      if (!elems || typeof elems.length !== 'number') continue
      for (let j = 0; j < elems.length; j++) {
        let em
        try {
          em = elems.get(j)
        } catch {
          continue
        }
        let type: unknown
        let imageData: unknown
        let svgData: unknown
        try {
          type = em.get('type')
          imageData = em.get('imageData')
          svgData = em.get('svgData')
        } catch {
          continue
        }
        if (type !== 'picture' && type !== 'image') continue
        out.pictures += 1
        const data = typeof imageData === 'string' ? imageData : typeof svgData === 'string' ? svgData : ''
        if (data.startsWith('data:') || data.startsWith('http')) out.withData += 1
        else if (data.startsWith('blob:')) out.blobOnly += 1
      }
    }
  } catch {
    // 무시
  }
  return out
}
