/**
 * shadow DOM을 뚫는 조회기.
 * 근거: xlsx lib는 도형을 shadow 아래(.xg-obj-unsupported)에,
 * pptx lib는 compat 토스트를 shadow 아래([data-testid=pptx-compat-toast])에 둔다.
 * light DOM querySelector만으로는 못 찾는다 (probe P1b/P3).
 * 폴링 없음 — 호출 시점 스냅샷 + MutationObserver/resize/scroll에서 재호출한다.
 */

const MAX_DEPTH = 8

/** root 아래 모든 Element를 shadow까지 내려가며 모은다. */
export function deepCollect(root: ParentNode): Element[] {
  const acc: Element[] = []
  const walk = (node: ParentNode, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let kids: Iterable<Element>
    try {
      kids = (node as Element).querySelectorAll?.('*') ?? []
    } catch {
      return
    }
    for (const el of kids) {
      acc.push(el)
      try {
        const sr = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot
        if (sr) walk(sr, depth + 1)
      } catch {
        /* 닫힌 shadow 등은 무시 */
      }
    }
  }
  walk(root, 0)
  return acc
}

function isVisible(el: Element): boolean {
  try {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  } catch {
    return false
  }
}

/** 셀렉터에 맞는 보이는 첫 요소 (문서 순서). */
export function deepQueryVisible(root: ParentNode, selector: string): Element | null {
  return deepQueryAllVisible(root, selector)[0] ?? null
}

/** 셀렉터에 맞는 보이는 요소 전부 (문서 순서). */
export function deepQueryAllVisible(root: ParentNode, selector: string): Element[] {
  const out: Element[] = []
  for (const el of deepCollect(root)) {
    try {
      if ((el as unknown as { matches?: (s: string) => boolean }).matches?.(selector) && isVisible(el)) out.push(el)
    } catch {
      /* 무시 */
    }
  }
  return out
}

/**
 * shadow를 뚫는 MutationObserver.
 * 컨테이너 바깥의 MO는 shadow 안의 삽입을 못 본다 (xlsx 도형이 그 경우).
 * 컨테이너 + 현재 모든 shadowRoot를 관찰하고, 콜백 때마다 새로 생긴
 * shadowRoot에도 관찰자를 붙인다. 폴링 없음.
 */
export function observeDeep(container: ParentNode, cb: () => void): () => void {
  const seen = new Set<ParentNode>()
  let mo: MutationObserver | null = null
  let dead = false
  const arm = (node: ParentNode): void => {
    if (seen.has(node) || dead) return
    seen.add(node)
    try {
      mo?.observe(node, { childList: true, subtree: true })
    } catch {
      /* 무시 */
    }
  }
  const rescan = (): void => {
    if (dead) return
    arm(container)
    for (const el of deepCollect(container)) {
      try {
        const sr = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot
        if (sr) arm(sr)
      } catch {
        /* 무시 */
      }
    }
  }
  try {
    mo = new MutationObserver(() => {
      rescan()
      cb()
    })
  } catch {
    return () => {}
  }
  rescan()
  return () => {
    dead = true
    try {
      mo?.disconnect()
    } catch {
      /* 무시 */
    }
    seen.clear()
  }
}
