/**
 * M7-2 생성 카운터 (측정 전용).
 *
 * 활성화: `?memDebug=1` 일 때만. 기본 off. prod exe에서도 동작한다.
 *   __memCounters()   // 누적 + 직전 호출 이후 초당 증가량
 *
 * 왜 필요한가: 렌더러 private 메모리가 초당 수 MB씩 오르는데
 * (작업관리자 기준) JS heap은 평탄하다. JS가 아니라 네이티브(캔버스·이미지·
 * DOM) 쪽에서 Something이 만들어지고 있다는 뜻이다. 무엇이 얼마나 만들어지는지
 * 세면 "3.4회/초 레이아웃"과 같은 주기로 늘어나는 항목을 바로 찾을 수 있다.
 *
 * 주의(AGENTS.md C3): globalThis를 덮어쓴다. 측정 전용이고 기본 off이며,
 * 이 계측이 켜진 상태의 성능 수치는 신뢰하지 말 것.
 */

export interface MemCounters {
  /** document.createElement 호출 수. */
  createElement: number
  /** createElement 중 canvas. */
  createElementCanvas: number
  /** new OffscreenCanvas. */
  offscreenCanvas: number
  /** canvas.getContext 호출 수. */
  getContext: number
  /** canvas.width/height 설정 횟수. */
  canvasSizeSet: number
  /** 생성된 canvas 중 아직 문서에 붙어 있는 것. */
  canvasLive: number
  /** 생성된 canvas 중 문서에서 떨어진 것(leak 신호). */
  canvasDetached: number
  /** 살아 있는 canvas의 총 픽셀(width×height 합). */
  canvasLivePixels: number
  /** new Image(). */
  imageCreated: number
  /** img.src = ... 설정 횟수. */
  imageSrcSet: number
  /** 그중 data: URL 건수. */
  imageSrcDataUrl: number
  /** data: URL 문자열 총 길이(바이트). */
  imageSrcDataUrlBytes: number
  /** data:가 아닌 src 건수. */
  imageSrcOther: number
  /**
   * setAttribute('href'|'xlink:href', data:...) 횟수.
   * lib은 SVG로 그리고 이미지는 `src`가 아니라 `href`를 쓴다.
   * 같은 data: 문자열을 다시 대입하면 매번 디코드된다.
   */
  hrefSet: number
  hrefDataUrl: number
  hrefDataUrlBytes: number
  /** createElementNS 건수. */
  createElementNS: number
  /** createElementNS 중 SVG image. */
  createElementNSImage: number
  /** createElementNS 중 SVG 전체. */
  createElementNSSvg: number
  /** createImageBitmap 호출 수. */
  createImageBitmap: number
  /** URL.createObjectURL / revokeObjectURL. */
  objectUrlCreated: number
  objectUrlRevoked: number
  /** MutationObserver: childList 변경 수(추가된 태그별). */
  mutationsChildList: number
  /** MutationObserver: attributes 변경 수(속성별). */
  mutationsAttributes: number
  /** 초당 mutation 수(버전). */
  mutationsPerSec: number
  /** 상위 5개: 추가된 태그명. */
  topAddedTags: Array<[string, number]>
  /** 상위 5개: 바뀐 속성명. */
  topChangedAttrs: Array<[string, number]>
}

interface Mutable {
  createElement: number
  createElementCanvas: number
  offscreenCanvas: number
  getContext: number
  canvasSizeSet: number
  imageCreated: number
  imageSrcSet: number
  imageSrcDataUrl: number
  imageSrcDataUrlBytes: number
  imageSrcOther: number
  hrefSet: number
  hrefDataUrl: number
  hrefDataUrlBytes: number
  createElementNS: number
  createElementNSImage: number
  createElementNSSvg: number
  createImageBitmap: number
  objectUrlCreated: number
  objectUrlRevoked: number
  mutationsChildList: number
  mutationsAttributes: number
  mutationsWindowStart: number
  mutationsWindow: number
  addedTags: Map<string, number>
  changedAttrs: Map<string, number>
}

const counters: Mutable = {
  createElement: 0,
  createElementCanvas: 0,
  offscreenCanvas: 0,
  getContext: 0,
  canvasSizeSet: 0,
  imageCreated: 0,
  imageSrcSet: 0,
  imageSrcDataUrl: 0,
  imageSrcDataUrlBytes: 0,
  imageSrcOther: 0,
  hrefSet: 0,
  hrefDataUrl: 0,
  hrefDataUrlBytes: 0,
  createElementNS: 0,
  createElementNSImage: 0,
  createElementNSSvg: 0,
  createImageBitmap: 0,
  objectUrlCreated: 0,
  objectUrlRevoked: 0,
  mutationsChildList: 0,
  mutationsAttributes: 0,
  mutationsWindowStart: Date.now(),
  mutationsWindow: 0,
  addedTags: new Map(),
  changedAttrs: new Map(),
}

const canvases = new Set<HTMLCanvasElement>()
let observer: MutationObserver | null = null
let observedRoot: Element | null = null
let attachTimer: ReturnType<typeof setInterval> | null = null

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1)
}

function topN(m: Map<string, number>, n: number): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

function observeRoot(root: Element): void {
  if (observedRoot === root) return
  observer?.disconnect()
  observedRoot = root
  observer = new MutationObserver((records) => {
    counters.mutationsWindow += records.length
    for (const r of records) {
      if (r.type === 'childList') {
        counters.mutationsChildList += 1
        for (const node of r.addedNodes) {
          const el = node as Element
          const tag = el?.tagName ? el.tagName.toLowerCase() : (node.nodeName || '?').toLowerCase()
          bump(counters.addedTags, tag)
        }
      } else if (r.type === 'attributes') {
        counters.mutationsAttributes += 1
        const name = r.attributeName ?? '?'
        const el = r.target as Element
        const tag = el?.tagName ? el.tagName.toLowerCase() : '?'
        bump(counters.changedAttrs, name)
        bump(counters.changedAttrs, `${tag}.${name}`)
      }
    }
  })
  observer.observe(root, { subtree: true, childList: true, attributes: true })
}

function attachObserverWhenReady(): void {
  if (attachTimer) return
  attachTimer = setInterval(() => {
    const root = document.querySelector('[data-testid="pptx-viewer-root"]')
    if (root) observeRoot(root)
    else if (observedRoot && !document.contains(observedRoot)) {
      observer?.disconnect()
      observer = null
      observedRoot = null
    }
  }, 500)
}

function patchCanvas(): void {
  const proto = HTMLCanvasElement.prototype
  const origCreate = document.createElement.bind(document)
  document.createElement = function patchedCreate(
    tagName: string,
    options?: ElementCreationOptions,
  ): HTMLElement {
    counters.createElement += 1
    const el = origCreate(tagName, options)
    if (tagName.toLowerCase() === 'canvas') {
      counters.createElementCanvas += 1
      canvases.add(el as HTMLCanvasElement)
    }
    return el
  } as typeof document.createElement

  const origGetContext = proto.getContext
  proto.getContext = function patchedGetContext(this: HTMLCanvasElement, ...args: unknown[]) {
    counters.getContext += 1
    return (origGetContext as (...a: unknown[]) => unknown).apply(this, args)
  } as typeof proto.getContext

  // width/height는 prototype의 accessor다. 설정 횟수를 센다.
  for (const prop of ['width', 'height'] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop)
    if (!desc?.get || !desc.set) continue
    const origGet = desc.get
    const origSet = desc.set
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get(this: HTMLCanvasElement) {
        return origGet.call(this)
      },
      set(this: HTMLCanvasElement, v: number) {
        counters.canvasSizeSet += 1
        origSet.call(this, v)
      },
    })
  }
}

function patchImage(): void {
  const OrigImage = window.Image
  const Patched = function PatchedImage(this: HTMLImageElement, width?: number, height?: number) {
    counters.imageCreated += 1
    return new (OrigImage as unknown as new (w?: number, h?: number) => HTMLImageElement)(width, height)
  } as unknown as typeof window.Image
  Patched.prototype = OrigImage.prototype
  window.Image = Patched

  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  if (desc?.get && desc.set) {
    const origGet = desc.get
    const origSet = desc.set
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get(this: HTMLImageElement) {
        return origGet.call(this)
      },
      set(this: HTMLImageElement, v: string) {
        counters.imageSrcSet += 1
        if (typeof v === 'string' && v.startsWith('data:')) {
          counters.imageSrcDataUrl += 1
          counters.imageSrcDataUrlBytes += v.length
        } else {
          counters.imageSrcOther += 1
        }
        origSet.call(this, v)
      },
    })
  }
}

function patchMisc(): void {
  // SVG: lib은 SVG로 그린다. 이미지는 <image href="data:..."> 형태라
  // HTMLImageElement.src 계측으로는 안 잡힌다. setAttribute로 잡는다.
  const origSetAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function patchedSetAttribute(
    this: Element,
    name: string,
    value: string,
  ): void {
    if (name === 'href' || name === 'xlink:href') {
      counters.hrefSet += 1
      if (typeof value === 'string' && value.startsWith('data:')) {
        counters.hrefDataUrl += 1
        counters.hrefDataUrlBytes += value.length
      }
    }
    return origSetAttr.call(this, name, value)
  } as typeof Element.prototype.setAttribute

  const origCreateNS = document.createElementNS.bind(document)
  document.createElementNS = function patchedCreateNS(
    namespaceURI: string | null,
    qualifiedName: string,
  ): Element {
    counters.createElementNS += 1
    const tag = qualifiedName.toLowerCase()
    if (tag === 'image') counters.createElementNSImage += 1
    if (tag === 'svg') counters.createElementNSSvg += 1
    return origCreateNS(namespaceURI, qualifiedName)
  } as typeof document.createElementNS

  const OrigOffscreen = window.OffscreenCanvas
  if (OrigOffscreen) {
    const Patched = function PatchedOffscreen(this: OffscreenCanvas, w: number, h: number) {
      counters.offscreenCanvas += 1
      return new OrigOffscreen(w, h)
    } as unknown as typeof window.OffscreenCanvas
    Patched.prototype = OrigOffscreen.prototype
    window.OffscreenCanvas = Patched
  }

  const origCIB = window.createImageBitmap
  if (origCIB) {
    window.createImageBitmap = ((...args: unknown[]) => {
      counters.createImageBitmap += 1
      return (origCIB as (...a: unknown[]) => unknown)(...args)
    }) as typeof window.createImageBitmap
  }

  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  URL.createObjectURL = ((obj: Blob | MediaSource) => {
    counters.objectUrlCreated += 1
    return (origCreate as (o: Blob | MediaSource) => string)(obj)
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    counters.objectUrlRevoked += 1
    return (origRevoke as (u: string) => void)(url)
  }) as typeof URL.revokeObjectURL
}

let installed = false

export function installMemCounters(): void {
  if (typeof window === 'undefined' || installed) return
  const on = new URLSearchParams(window.location.search).get('memDebug') === '1'
  if (!on) return
  installed = true
  try {
    patchCanvas()
    patchImage()
    patchMisc()
  } catch {
    // 계측 실패가 앱 동작을 막지 않는다.
  }
  attachObserverWhenReady()
  const w = window as unknown as Record<string, unknown>
  w.__memCounters = (): MemCounters => {
    let live = 0
    let detached = 0
    let pixels = 0
    for (const c of canvases) {
      if (document.contains(c)) {
        live += 1
        pixels += (c.width || 0) * (c.height || 0)
      } else {
        detached += 1
      }
    }
    const now = Date.now()
    const winSec = (now - counters.mutationsWindowStart) / 1000
    const perSec = winSec > 0 ? counters.mutationsWindow / winSec : 0
    counters.mutationsWindow = 0
    counters.mutationsWindowStart = now
    return {
      createElement: counters.createElement,
      createElementCanvas: counters.createElementCanvas,
      offscreenCanvas: counters.offscreenCanvas,
      getContext: counters.getContext,
      canvasSizeSet: counters.canvasSizeSet,
      canvasLive: live,
      canvasDetached: detached,
      canvasLivePixels: pixels,
      imageCreated: counters.imageCreated,
      imageSrcSet: counters.imageSrcSet,
      imageSrcDataUrl: counters.imageSrcDataUrl,
      imageSrcDataUrlBytes: counters.imageSrcDataUrlBytes,
      imageSrcOther: counters.imageSrcOther,
      hrefSet: counters.hrefSet,
      hrefDataUrl: counters.hrefDataUrl,
      hrefDataUrlBytes: counters.hrefDataUrlBytes,
      createElementNS: counters.createElementNS,
      createElementNSImage: counters.createElementNSImage,
      createElementNSSvg: counters.createElementNSSvg,
      createImageBitmap: counters.createImageBitmap,
      objectUrlCreated: counters.objectUrlCreated,
      objectUrlRevoked: counters.objectUrlRevoked,
      mutationsChildList: counters.mutationsChildList,
      mutationsAttributes: counters.mutationsAttributes,
      mutationsPerSec: Math.round(perSec),
      topAddedTags: topN(counters.addedTags, 5),
      topChangedAttrs: topN(counters.changedAttrs, 5),
    }
  }
}
