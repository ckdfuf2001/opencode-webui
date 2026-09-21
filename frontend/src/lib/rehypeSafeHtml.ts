/**
 * rehypeRaw 뒤에 붙는 경량 sanitize.
 * 모델 출력 속 raw HTML을 그대로 DOM 렌더하면 알 수 없는 태그가
 * React 경고를 띄우거나 렌더 크래시로 앱 전체를 죽인다
 * (프론트에 에러 경계가 없어 한 파트가 터지면 트리 전체가 언마운트된다).
 * - 허용 목록 밖 태그는 벗겨내고 자식(텍스트)은 유지한다.
 * - script/style 등은 내용까지 통째로 버린다.
 * - on* 핸들러·위험 스킴(javascript:/data:/vbscript:) 속성은 제거한다.
 * rehype-sanitize 의존 없이 동작한다 (pnpm workspace 설치 충돌 회피).
 */

type HastNode = {
  type?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

// 자식은 살리고 태그만 벗긴다
const UNWRAP = new Set([
  'div', 'span', 'p', 'pre', 'code',
  'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del', 's', 'u',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'br', 'hr', 'details', 'summary',
])

// 내용ごと 버린다 (텍스트로 보여줄 이유가 없음)
const DROP_ENTIRELY = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta',
  'title', 'base', 'head', 'body', 'html', 'form', 'noscript',
  'textarea', 'select', 'option', 'button', 'video', 'audio',
  'source', 'track', 'canvas', 'svg', 'math',
])

function isSafeUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const s = value.trim().toLowerCase()
  if (s === '' || s.startsWith('#') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true
  if (/^[a-z][a-z0-9+.-]*:/.test(s)) {
    return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('mailto:')
  }
  return true
}

function scrubProps(tag: string, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if (/^on/i.test(k)) continue
    if (tag === 'a' && k === 'href') {
      if (isSafeUrl(v)) out[k] = v
      continue
    }
    if (tag === 'img' && (k === 'src' || k === 'href')) {
      if (isSafeUrl(v)) out[k] = v
      continue
    }
    if (k === 'src' || k === 'href' || k === 'xlink:href' || k === 'action' || k === 'formaction') continue
    if (tag === 'a' && (k === 'title' || k === 'target' || k === 'rel')) { out[k] = v; continue }
    if (tag === 'img' && (k === 'alt' || k === 'title' || k === 'width' || k === 'height')) { out[k] = v; continue }
    if (tag === 'input' && (k === 'type' || k === 'checked' || k === 'disabled')) {
      if (k === 'type' && v !== 'checkbox') continue
      out[k] = v
      continue
    }
    if (tag === 'details' && k === 'open') { out[k] = v; continue }
    // 나머지는 버린다 (style·className·data-* 포함 — 모델 출력 장식에 불필요)
  }
  return out
}

function sanitizeChildren(children: HastNode[] | undefined): HastNode[] {
  if (!children) return []
  const out: HastNode[] = []
  for (const child of children) {
    sanitizeNode(child, out)
  }
  return out
}

function sanitizeNode(node: HastNode, out: HastNode[]): void {
  if (!node || typeof node !== 'object') return
  if (node.type !== 'element' || typeof node.tagName !== 'string') {
    out.push(node)
    return
  }
  const tag = node.tagName.toLowerCase()
  if (DROP_ENTIRELY.has(tag)) return
  if (tag === 'a') {
    node.properties = scrubProps(tag, node.properties ?? {})
    node.children = sanitizeChildren(node.children)
    out.push(node)
    return
  }
  if (tag === 'img') {
    node.properties = scrubProps(tag, node.properties ?? {})
    node.children = []
    out.push(node)
    return
  }
  if (tag === 'input') {
    const props = scrubProps(tag, node.properties ?? {})
    if (props['type'] !== 'checkbox') return
    node.properties = props
    node.children = []
    out.push(node)
    return
  }
  if (UNWRAP.has(tag)) {
    // 서식 태그는 태그 유지하되 속성은 버린다 (정렬 style 등 미지원 — 안전 우선)
    node.properties = {}
    node.children = sanitizeChildren(node.children)
    out.push(node)
    return
  }
  // 알 수 없는 태그(anonymous·think 등): 태그만 벗기고 텍스트는 살린다
  for (const child of sanitizeChildren(node.children)) out.push(child)
}

// rehype 플러그인 (attacher)
export function rehypeSafeHtml() {
  return (tree: HastNode) => {
    if (tree && Array.isArray(tree.children)) {
      tree.children = sanitizeChildren(tree.children)
    }
  }
}
