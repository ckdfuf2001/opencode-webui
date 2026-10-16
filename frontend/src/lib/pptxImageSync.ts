/**
 * lib(ooxml-core)이 그림을 blob: URL로 만들면 Y.Doc로 동기화될 때 joiner에게 죽은 문자열이 된다.
 * 증상: 먼저 들어간 사람만 이미지가 보이고, 편집 진입·늦은 합류자는 imageless.
 * (구버전 놓침: 실제 생성 지점은 handler.runtime 객체의 createImageUrl이며,
 *  PptxHandler.prototype에는 createImageUrl이 없어 prototype 패치는 무효과였다.)
 *
 * 수정: runtime.createImageUrl을 data: URL로 고정한다.
 * data: URL은 Y.Doc를 타고도 살아남고 새로고침에도 안전하다.
 * 대가: base64 +33% 메모리. blob 캐시·revoke 로직은 data:에 무해하다.
 */

import { PptxHandler, createDefaultPptxHandlerRuntime } from 'ooxml-core/pptx'

interface PptxRuntimeLike {
  createImageUrl: (bytes: ArrayBuffer, mimeType: string) => string
}

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

/**
 * 그림 URL 생성을 data:로 고정한다.
 * - 주 경로: 런타임 클래스 prototype을 덮어써 이후 모든 핸들러 인스턴스에 적용.
 * - 보조: 패치 전에 만들어진 핸들러를 위해 getImageData 진입점에서 인스턴스를 확인.
 */
export function ensurePptxImagesSyncable(): void {
  const patchRuntime = (rt: PptxRuntimeLike | undefined): void => {
    try {
      if (!rt || typeof rt.createImageUrl !== 'function') return
      const target = rt as unknown as Record<string, unknown>
      if (target[PATCH_KEY]) return
      rt.createImageUrl = bytesToDataUrl
      target[PATCH_KEY] = true
    } catch {
      // 무시
    }
  }
  try {
    // 1) 런타임 prototype (이후 생성되는 모든 핸들러)
    const proto = Object.getPrototypeOf(
      createDefaultPptxHandlerRuntime() as unknown as PptxRuntimeLike,
    ) as unknown as Record<string, unknown>
    if (typeof proto?.createImageUrl === 'function' && !(PATCH_KEY in proto)) {
      proto.createImageUrl = bytesToDataUrl
      proto[PATCH_KEY] = true
    }
  } catch {
    // 무시
  }
  try {
    // 2) 이미 만들어진 핸들러 대비
    const handlerProto = PptxHandler.prototype as unknown as Record<string, unknown>
    if (typeof handlerProto.getImageData === 'function' && !(PATCH_KEY in handlerProto)) {
      const original = handlerProto.getImageData as (
        this: { runtime?: PptxRuntimeLike },
        path: string,
      ) => Promise<unknown>
      handlerProto.getImageData = function (this: { runtime?: PptxRuntimeLike }, path: string) {
        patchRuntime(this?.runtime)
        return original.call(this, path)
      }
      handlerProto[PATCH_KEY] = true
    }
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
        let em: { get: (k: string) => unknown }
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
        const data =
          typeof imageData === 'string' ? imageData : typeof svgData === 'string' ? svgData : ''
        if (data.startsWith('data:') || data.startsWith('http')) out.withData += 1
        else if (data.startsWith('blob:')) out.blobOnly += 1
      }
    }
  } catch {
    // 무시
  }
  return out
}