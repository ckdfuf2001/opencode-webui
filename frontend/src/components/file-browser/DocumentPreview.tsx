import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, Suspense } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertCircle, ZoomIn, ZoomOut, User, Users, Clock, Paperclip, File, RefreshCw, Reply, Pencil, Check, RotateCcw, Trash2, X } from 'lucide-react'
import { ViewerLoadBoundary } from './ViewerBoundaries'
import { lazyWithRetry } from './lazyRetry'
import { loadPptxViewer, loadSpreadsheetEditor, loadVisioViewer, loadWordEditor } from './viewerLoaders'

let SpreadsheetEditor = lazyWithRetry(loadSpreadsheetEditor)
let PptxViewer = lazyWithRetry(loadPptxViewer)
let WordEditor = lazyWithRetry(loadWordEditor)
let VisioViewer = lazyWithRetry(loadVisioViewer)

/** 청크 로드 실패 시 lazy를 새걸로 갈아끼운다 (다시 시도 버튼용). */
function bustViewerChunks(): void {
  SpreadsheetEditor = lazyWithRetry(loadSpreadsheetEditor)
  PptxViewer = lazyWithRetry(loadPptxViewer)
  WordEditor = lazyWithRetry(loadWordEditor)
  VisioViewer = lazyWithRetry(loadVisioViewer)
}
import type { FileInfo } from '@/types/files'
import { API_BASE_URL } from '@/config'
import { Button } from '@/components/ui/button'
import EngineHost from './EngineHost'
import { layoutAnchoredTextBoxes } from './docxAnchorLayout'
import { sanitizeDocxForEdit } from './docxEditSanitize'
import { loadDocxComments, type DocxComment } from './docxComments'
import { addDocxComment, replyDocxComment, setDocxCommentDone, editDocxComment, deleteDocxComment } from './docxCommentWriter'
import { useOfficeSave, saveOfficeBytes } from './officeSave'
import { showToast } from '@/lib/toast'
import { loadXlsxComments, loadXlsxSheetNames, type XlsxComment } from './xlsxComments'
import { addXlsxComment, replyXlsxComment, setXlsxCommentDone, editXlsxComment, deleteXlsxComment } from './xlsxCommentWriter'
import { collabApi, collabServerUrl, type CollabRoomSummary } from '@/api/collab'
import { detectDocKind, type DocKind } from './docKind'
import { useTheme } from '@/hooks/useTheme'
import { readCollabUser } from '@/lib/collabUser'
import { hasEmbObject, isBlockedXlsxEdit, decideObjectOp, NO_OBJECT_GUARD, shouldFlushOnPeerArrive, type ObjectGuardCtx } from '@/lib/xlsxCollabGuard'
import { anchorKey, assignObjectKeys, createObjectTapProvider, describeDrawingKind, diffObjects, type DrawingLike, type ObjectsStateMsg } from '@/lib/xlsxObjects'
import { CollabPresenceBar, CollabPresenceShell } from '@/components/collab/CollabPresence'
import type { PresencePeerView } from '@/components/collab/collabPresenceView'

type ExtractedMsg = {
  html?: string
  attachments?: Array<{ name: string; size: number; cid: string; mime: string }>
}

const CONVERTABLE_CLIENT_KINDS = new Set<DocKind>(['pdf', 'docx', 'xlsx', 'pptx'])

/**
 * X1b: XLSX 저장은 lib(ooxml-ui xlsx)가 방을 소유하므로 owner clientId 가 없다.
 * 서버는 xlsx 방에서 owner 검사를 건너뛰고 낙관적 잠금으로만 판정한다 ⇒ 값은 자리표시자.
 */
const XLSX_SAVE_CLIENT_ID = 0

/** C2-c: 자동 저장 디바운스. 편집이 멈추면 owner만 저장한다. */
const AUTOSAVE_DEBOUNCE_MS = 2500

/**
 * C1: lib collaborationState.people 항목 (패치된 ooxml-ui가 role+sheet+range를 싣는다).
 * PPT의 usePeers와 같은 마크업으로 아래 presence 바에 그린다.
 */
/** C3: lib presence 항목을 공용 바 형식으로 바꾼다. */
function xlsxPersonToView(p: XlsxPresencePerson): PresencePeerView {
  return {
    id: String(p.clientId),
    name: p.name,
    color: p.color,
    mode: p.role === 'viewer' ? 'view' : 'edit',
    isSelf: p.self,
    isOwner: false,
    tabCount: 1,
    sheetIndex: p.sheetIndex,
    range: p.range,
  }
}

/**
 * C4-3: 같은 userId는 하나로 묶는다 (lib 타이틀바 participants 패치·서버
 * roomParticipants와 같은 규칙: userId 기준, 없으면 clientId 기준).
 * 재연결 churn·half-open으로 같은 사용자가 잠시 여러 항목으로 보여도
 * 아바타는 1개로 유지된다. id는 "u:<userId>" 또는 "c:<clientId>".
 */
function groupXlsxPeopleForView(list: XlsxPresencePerson[]): PresencePeerView[] {
  const groups = new Map<string, XlsxPresencePerson[]>()
  for (const p of list) {
    const key = typeof p.userId === 'string' && p.userId ? `u:${p.userId}` : `c:${p.clientId}`
    const g = groups.get(key)
    if (g) g.push(p)
    else groups.set(key, [p])
  }
  const out: PresencePeerView[] = []
  for (const [key, members] of groups) {
    const sorted = [...members].sort((a, b) => a.clientId - b.clientId)
    const first = sorted[0]!
    const view = xlsxPersonToView(first)
    view.id = key
    view.tabCount = members.length
    view.isSelf = members.some((m) => m.self)
    out.push(view)
  }
  return out
}

interface XlsxPresencePerson {
  clientId: number
  name: string
  color: string
  self: boolean
  userId?: string
  role?: string
  sheet?: string
  range?: string
  sheetIndex?: number
}

/** C1: people 비교. heartbeat 재게시(10초)로 내용이 같아도 새 배열이 오므로 필드 단위로 본다. */
function sameXlsxPeople(a: XlsxPresencePerson[], b: XlsxPresencePerson[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (
      x.clientId !== y.clientId || x.name !== y.name || x.color !== y.color ||
      x.self !== y.self || x.userId !== y.userId || x.role !== y.role ||
      x.sheet !== y.sheet || x.range !== y.range || x.sheetIndex !== y.sheetIndex
    ) {
      return false
    }
  }
  return true
}

const SPINNER = (
  <div className="flex items-center justify-center py-12">
    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
  </div>
)

function ErrorNote({ msg }: { msg: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center px-6">
      <AlertCircle className="w-6 h-6 text-destructive mb-2" />
      <p className="text-sm text-muted-foreground">Cannot preview this document.</p>
      {msg && <p className="text-xs text-destructive mt-1">{msg}</p>}
    </div>
  )
}

function useRawFile(path: string, enabled = true, reloadKey = 0) {
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [error, setError] = useState('')
  // X1c(P0): 파일을 **읽은 시점**의 디스크 해시(ETag). 단독 저장의 If-Match 에 쓴다.
  // 저장 직전에 다시 읽으면 잠금이 무의미해진다(그 사이 변경을 못 본다).
  const [etag, setEtag] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) {
      setData(null)
      setStatus('idle')
      return
    }
    let cancelled = false
    setStatus('loading')
    setData(null)
    setError('')
    // 간헐 loopback 차단은 1회 재시도한다 (HTTP 상태가 있으면 재시도 안 함).
    const load = async (attempt: number): Promise<void> => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/files/${path}?raw=true`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        if (!cancelled) {
          setData(buf)
          setStatus('ready')
          setEtag(res.headers.get('etag'))
        }
      } catch (e) {
        const status = (e as { status?: number })?.status
        if (attempt === 0 && typeof status !== 'number' && !cancelled) {
          await new Promise((r) => setTimeout(r, 800))
          if (!cancelled) await load(1)
          return
        }
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load file')
          setStatus('error')
        }
      }
    }
    void load(0)
    return () => {
      cancelled = true
      setData(null)
      setStatus('idle')
      setEtag(null)
    }
  }, [path, enabled, reloadKey])

  return { data, status, error, etag }
}

/** 변환 서비스 부팅 대기 예산 — doc-converter cold start가 20~90초 걸린다. */
const WARM_RETRY_MS = 5000
const WARM_RETRY_MAX = 24

function useConvertedPdf(path: string, refreshKey = 0, enabled = true) {
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [status, setStatus] = useState<'loading' | 'warming' | 'ready' | 'unavailable' | 'error'>('loading')
  const [error, setError] = useState('')
  // 깨진 캐시(PDF 아님)면 1회만 refresh로 재생성해 자동 치유한다.
  const [healed, setHealed] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setData(null)
      setStatus('unavailable')
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let retries = 0
    const abort = new AbortController()
    setStatus('loading')
    setData(null)
    setError('')
    const useRefresh = refreshKey > 0 || healed
    const refresh = useRefresh ? '&refresh=1' : ''
    const load = () => {
      fetch(`${API_BASE_URL}/api/preview/pdf?path=${encodeURIComponent(path)}${refresh}`, { signal: abort.signal })
        .then(async (res) => {
          if (cancelled) return
          if (res.status === 503) {
            // 변환 서비스가 아직 안 떴다 — 끄지 말고 기동될 때까지 재시도한다.
            // (첫 요청이 부팅을 트리거하므로 503을 곧바로 폴백 확정하면 안 된다)
            if (retries < WARM_RETRY_MAX) {
              retries += 1
              setStatus('warming')
              timer = setTimeout(load, WARM_RETRY_MS)
            } else {
              setStatus('unavailable')
            }
            return
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const buf = await res.arrayBuffer()
          if (cancelled) return
          // 깨진 캐시(동시 변환 경합의 잔재)면 1회만 재생성한다.
          if (!isPdfBuffer(buf) && !healed) {
            setHealed(true)
            return
          }
          if (!isPdfBuffer(buf)) throw new Error('Invalid PDF structure')
          setData(buf)
          setStatus('ready')
        })
        .catch((e) => {
          if (cancelled) return
          if (e instanceof DOMException && e.name === 'AbortError') return
          setError(e instanceof Error ? e.message : 'Failed to convert document')
          setStatus('error')
        })
    }
    load()
    return () => {
      cancelled = true
      abort.abort()
      if (timer) clearTimeout(timer)
      setData(null)
      setStatus('unavailable')
    }
  }, [path, refreshKey, enabled, healed])

  return { data, status, error }
}

function isPdfBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 5) return false
  const head = new Uint8Array(buf.slice(0, 5))
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d
}

function useExtractedText(path: string, refreshKey = 0, enabled = true) {
  const [data, setData] = useState<{ text: string; fileName?: string; msg?: ExtractedMsg } | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled) {
      setData(null)
      setStatus('unavailable')
      return
    }
    let cancelled = false
    setStatus('loading')
    setData(null)
    setError('')
    fetch(`${API_BASE_URL}/api/preview/extract?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, refresh: refreshKey > 0 }),
    })
      .then(async (res) => {
        if (res.status === 503) {
          if (!cancelled) setStatus('unavailable')
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!cancelled) {
          setData({ text: json.text ?? '', fileName: json.fileName, msg: json.msg })
          setStatus('ready')
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to extract text')
          setStatus('error')
        }
      })
    return () => {
      cancelled = true
      setData(null)
      setStatus('unavailable')
    }
  }, [path, refreshKey, enabled])

  return { data, status, error }
}

function PdfPage({ pdf, pageNumber, zoom = 1, containerWidth = null }: { pdf: any; pageNumber: number; zoom?: number; containerWidth?: number | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      if (cancelled) { try { page.cleanup?.() } catch {} ; return }
      const canvas = canvasRef.current
      if (!canvas) return
      const avail = wrapRef.current?.getBoundingClientRect().width ?? 0
      const dpr = window.devicePixelRatio || 1
      const base = page.getViewport({ scale: 1 })
      const scale = avail > 0 ? Math.min((avail / base.width) * zoom, 4) : 1
      const viewport = page.getViewport({ scale })
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      await page.render({ canvasContext: ctx, transform, viewport }).promise
      try { page.cleanup?.() } catch {}
      if (!cancelled) setLoading(false)
    })().catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
        canvas.width = 0
        canvas.height = 0
      }
    }
  }, [pdf, pageNumber, zoom, containerWidth])

  return (
    <div ref={wrapRef} className="mx-auto" style={{ width: `${zoom * 100}%` }}>
      <div className="relative mx-auto bg-white rounded-md shadow-sm overflow-hidden" style={{ width: 'fit-content' }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/30">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        )}
        <canvas ref={canvasRef} className="block" />
      </div>
    </div>
  )
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25

function DocumentShell({ fileName, pageCount, children }: { fileName?: string; pageCount?: number; children: (zoom: number, containerWidth: number | null) => ReactNode }) {
  const [zoom, setZoom] = useState(1)
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setZoom(1)
  }, [fileName])

  // Track the preview area size so pages re-fit when it changes (fullscreen
  // toggle, panel resize). Without this the scale computed for the old width
  // stayed frozen after entering fullscreen.
  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      setContainerWidth(width > 0 ? Math.round(width) : null)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The file header owns the fullscreen toggle ('Enter fullscreen'). Reset to
  // 100% on entry so pages re-fit the larger viewport.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ isFullscreen?: boolean }>).detail
      if (detail?.isFullscreen) setZoom(1)
    }
    window.addEventListener('fileFullscreenChange', handler)
    return () => window.removeEventListener('fileFullscreenChange', handler)
  }, [])

  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))

  const title = fileName ?? 'Document preview'

  return (
    <div className="flex flex-col h-full min-h-[200px]">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-background flex-shrink-0">
        <span className="text-xs text-muted-foreground truncate">
          {title}
          {pageCount != null ? ` · ${pageCount} pages` : ''}
        </span>
        <div className="flex items-center gap-1">
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={() => setZoom(1)} />
        </div>
      </div>
      <div ref={contentRef} className="flex-1 min-h-0 overflow-auto bg-muted/40">
        {children(zoom, containerWidth)}
      </div>
    </div>
  )
}

function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}) {
  const iconClass = 'w-3.5 h-3.5'
  return (
    <div className="flex items-center gap-0.5">
      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onZoomOut} title="Zoom out">
        <ZoomOut className={iconClass} />
      </Button>
      <button
        type="button"
        onClick={onReset}
        title="Reset zoom"
        className="px-1 text-[11px] tabular-nums text-muted-foreground hover:text-foreground min-w-[40px] text-center"
      >
        {Math.round(zoom * 100)}%
      </button>
      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onZoomIn} title="Zoom in">
        <ZoomIn className={iconClass} />
      </Button>
    </div>
  )
}

function PdfViewer({ data, fileName }: { data: ArrayBuffer; fileName?: string }) {
  const [pdf, setPdf] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let doc: any = null
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        doc = await pdfjs.getDocument({ data: data.slice(0) }).promise
        if (!cancelled) setPdf(doc)
        else doc?.destroy?.()
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load PDF')
      }
    })()
    return () => {
      cancelled = true
      if (doc) doc.destroy?.()
      setPdf(null)
      setError(null)
    }
  }, [data])

  if (error) return <ErrorNote msg={error} />
  if (!pdf) return SPINNER

  const pages = Array.from({ length: pdf.numPages }, (_, i) => i + 1)
  return (
    <DocumentShell fileName={fileName} pageCount={pdf.numPages}>
      {(zoom, containerWidth) => (
        <div key={`${zoom}:${containerWidth ?? 0}`} className="p-3 space-y-3">
          {pages.map((n) => (
            <PdfPage key={n} pdf={pdf} pageNumber={n} zoom={zoom} containerWidth={containerWidth} />
          ))}
        </div>
      )}
    </DocumentShell>
  )
}

export function DocumentPreview({ file, refreshKey = 0, onEditingChange }: { file: FileInfo; refreshKey?: number; onEditingChange?: (editing: boolean) => void }) {
  const kind = detectDocKind(file.name)
  // office 문서(docx/xlsx/pptx)는 바로 보기 우선 — PDF 변환 없이 바로 본다.
  // PDF가 필요하면 토글로 서버 변환을 켠다.
  const isOfficeNative = kind === 'docx' || kind === 'xlsx' || kind === 'pptx'
  const isViewerOnly = kind === 'visio'
  const [pdfMode, setPdfMode] = useState(false)
  const [editing, setEditing] = useState(false)
  const [viewerRetry, setViewerRetry] = useState(0)
  const [endingEdit, setEndingEdit] = useState(false)
  // X2a-③: XlsxViewer 가 방에 편집자가 있음을 알리면(보기 모드) 코멘트 버튼을 막는다.
  const [xlsxRoomHasEditors, setXlsxRoomHasEditors] = useState(false)
  useEffect(() => { setPdfMode(false); setEditing(false) }, [file.path])
  useEffect(() => { setXlsxRoomHasEditors(false) }, [editing, file.path])
  // U3: 편집 상태를 상위(FilePreview)에 알린다 — 편집 화면에서는 앱 헤더를
  // 숨기고 에디터가 컨테이너 전체를 채우게 한다.
  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])
  useEffect(() => () => onEditingChange?.(false), [onEditingChange])
  const retryViewer = () => {
    bustViewerChunks()
    setViewerRetry((v) => v + 1)
  }
  // (M14) fileFullscreenChange(도형 편집 종료) 처리는 endEditing 정의 뒤에 둔다
  // (endEditing 을 deps 로 참조하므로 TDZ 를 피해야 한다).
  // 저장 성공하면 편집을 끝내고 전체화면에서 복귀한다 (채팅 자리로).
  // B1(b): 이 이벤트는 window 전역이고 파일 식별자가 없다. 다른 뷰어(예: PptxViewer.tsx:519)
  // 도 같은 이벤트를 쏘므로, XLSX 편집 중 PPT 저장이 끝나면 편집이 죽었다.
  // path 없는 응답은 "우리 호출의 응답"일 수 없으므로 무시한다.
  useEffect(() => {
    const onDone = (e: Event) => {
      const d = (e as CustomEvent<{ ok?: boolean; path?: string; keepEditing?: boolean }>).detail
      if (!d?.ok) return
      if (!d.path || d.path !== file.path) return
      // X1b: XLSX 저장은 편집을 유지한다(Save ≠ Done). 저장으로 편집이 끝나면
      // lib 이 소유한 방 세션까지 내려가 presence 가 사라진다.
      // "Done" 은 endEditing 이 별도로 편집을 끝낸다.
      if (d.keepEditing) return
      setEditing(false)
      window.dispatchEvent(new CustomEvent('fileFullscreenRequest', { detail: { isFullscreen: false } }))
    }
    window.addEventListener('officeSaveDone', onDone as EventListener)
    return () => window.removeEventListener('officeSaveDone', onDone as EventListener)
  }, [file.path])
  // P1-6: 편집 종료는 flush가 끝날 때까지 기다린다. 실패하면 편집 유지(유실 방지).
  /** X1c: { ok, hasFailedCopy } 를 돌려준다 — 실패 바이트 보관 중이면 Done 앞에 확인을 묻는다. */
  const requestOfficeSave = useCallback(
    (): Promise<{ ok: boolean; hasFailedCopy: boolean }> => {
      return new Promise((resolve) => {
        let done = false
        const timer = setTimeout(() => {
          if (done) return
          done = true
          window.removeEventListener('officeSaveDone', onDone)
          resolve({ ok: false, hasFailedCopy: false })
        }, 10000)
        const onDone = (e: Event) => {
          if (done) return
          done = true
          clearTimeout(timer)
          window.removeEventListener('officeSaveDone', onDone as EventListener)
          const d = (e as CustomEvent<{ ok?: boolean; hasFailedCopy?: boolean }>).detail
          resolve({ ok: !!d?.ok, hasFailedCopy: !!d?.hasFailedCopy })
        }
        window.addEventListener('officeSaveDone', onDone as EventListener)
        window.dispatchEvent(new CustomEvent('officeSaveRequest'))
      })
    },
    [],
  )
  const endEditing = useCallback(async (after?: () => void) => {
    if (!editing || endingEdit) {
      after?.()
      return
    }
    setEndingEdit(true)
    try {
      // X1c(P0-2): 실패 바이트 보관 중이면 Ok 확인을 묻는다 — 그냥 닫으면 편집이 사라진다.
      // X1d(P0): 확인(OK)을 누르면 **닫는다** — 저장이 실패해도 확인했다는 뜻은 닫겠다는 뜻.
      // 거부(취소)만 편집 화면에 남는다.
      const outcome = await requestOfficeSave()
      let confirmedDiscard = false
      if (!outcome.ok && outcome.hasFailedCopy) {
        confirmedDiscard = window.confirm(
          '저장하지 않은 변경이 있습니다(디스크가 바뀌어 저장이 막혔습니다).\n' +
          '내 사본을 내려받았나요? 확인(OK)하면 편집 화면을 닫습니다.',
        )
      }
      if (outcome.ok || confirmedDiscard) {
        setEditing(false)
        if (confirmedDiscard) showToast.info('확인을 눌렀으므로 편집 화면을 닫습니다(사본은 닫기 전에 내려받으세요)')
        window.dispatchEvent(new CustomEvent('fileFullscreenRequest', { detail: { isFullscreen: false } }))
        after?.()
      } else {
        showToast.error('Save failed — staying in edit mode')
      }
    } finally {
      setEndingEdit(false)
    }
  }, [editing, endingEdit, requestOfficeSave])
  // M15: Escape(도형 편집 종료)로 앱 편집 모드가 끝날 때, **flush(저장)를 await 한 뒤** 종료한다.
  // 바로 setEditing(false) 하면 뷰어 리마운트(편집 모드 종료 → viewerKey 변경) 사이에
  // lib 의 미처리 write-back 이 유실된다 → 커밋이 디스크에 반영되지 않는다(조용한 유실).
  // (P1-6 "편집 종료는 flush 가 끝날 때까지 기다린다" 를 Escape 경로에도 적용.)
  useEffect(() => {
    const onFs = (e: Event) => {
      const d = (e as CustomEvent<{ isFullscreen?: boolean; path?: string }>).detail
      if (d?.isFullscreen) return
      // M15(3절): 자기 파일의 이벤트만 처리한다(전역 이벤트이므로 경로 비교가 필수).
      if (!d?.path || d.path !== file.path) return
      // 편집 중이 아니면 무시, 종료 중이면 재진입 방지.
      if (!editing || endingEdit) return
      void endEditing()
    }
    window.addEventListener('fileFullscreenChange', onFs)
    return () => window.removeEventListener('fileFullscreenChange', onFs)
  }, [endEditing, editing, endingEdit, file.path])
  const converted = useConvertedPdf(file.path, refreshKey, kind !== 'msg' && kind !== 'visio' && (!isOfficeNative || pdfMode))
  const extracted = useExtractedText(file.path, refreshKey, kind === 'msg')

  // U2: Done/Save/Comments 를 뷰어 타이틀바 우측(기능 search 오른쪽, actions 슬롯)에 둔다.
  // PPT 만 lib 타이틀바 슬롯(titleBarSlot → actions)을 노출한다 — XLSX/DOCX 는 헤더를 유지한다.
  const pptxEditorActions = kind === 'pptx' ? (
    <div data-testid="preview-editor-actions" className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => { void endEditing() }}
        disabled={endingEdit}
        className="h-6 text-xs px-2 rounded bg-background text-foreground shadow-sm font-medium disabled:opacity-50"
        title="편집 종료 (저장 후 원래 화면으로)"
      >
        Done
      </button>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('officeSaveRequest'))}
        className="h-6 text-xs px-2 rounded text-muted-foreground hover:text-foreground"
        title="즉시 저장"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('pptxCommentsRequest'))}
        className="h-6 text-xs px-2 rounded text-muted-foreground hover:text-foreground"
        title="코멘트 보기"
      >
        Comments
      </button>
    </div>
  ) : null

  const hasClientFallback = kind ? CONVERTABLE_CLIENT_KINDS.has(kind) : false
  /** C2-a: ETag 누락 시 같은 파일을 다시 받기 위한 재수신 트리거. */
  const [fileReloadKey, setFileReloadKey] = useState(0)
  const { data: raw, status: rawStatus, error: rawError, etag: rawEtag } = useRawFile(
    file.path,
    isOfficeNative ? !pdfMode : isViewerOnly || (hasClientFallback && converted.status !== 'ready'),
    fileReloadKey,
  )

  if (!kind) return null

  const renderRawBody = (): ReactNode => {
    if (rawStatus === 'loading') return SPINNER
    if (rawStatus === 'ready' && raw) {
      const bkey = `${file.path}#${viewerRetry}`
      if (kind === 'pdf') return <PdfViewer data={raw} fileName={file.name} />
      if (kind === 'docx') {
        return (
          <ViewerLoadBoundary key={bkey} onRetry={retryViewer}>
            <DocxViewer data={raw} fileName={file.name} editing={editing} path={file.path} />
          </ViewerLoadBoundary>
        )
      }
      if (kind === 'xlsx') {
        return (
          <ViewerLoadBoundary key={bkey} onRetry={retryViewer}>
            <XlsxViewer data={raw} fileName={file.name} editing={editing} path={file.path} etag={rawEtag} onRoomHasEditorsChange={setXlsxRoomHasEditors} onRequestReload={() => setFileReloadKey((k) => k + 1)} />
          </ViewerLoadBoundary>
        )
      }
      if (kind === 'visio') {
        return (
          <ViewerLoadBoundary key={bkey} onRetry={retryViewer}>
            <OfficeVisioViewer data={raw} fileName={file.name} />
          </ViewerLoadBoundary>
        )
      }
      return (
        <ViewerLoadBoundary key={bkey} onRetry={retryViewer} onPdf={() => setPdfMode(true)}>
          <PptxViewer
            key={file.path}
            data={raw}
            fileName={file.name}
            editing={editing}
            savePath={file.path}
            titleBarSlot={editing ? pptxEditorActions : undefined}
            onFail={() => setPdfMode(true)}
          />
        </ViewerLoadBoundary>
      )
    }
    if (rawStatus === 'error') return <ErrorNote msg={rawError} />
    return null
  }

  let body: ReactNode
  if (kind === 'msg') {
    if (extracted.status === 'loading') {
      body = SPINNER
    } else if (extracted.status === 'ready' && extracted.data) {
      body = <ExtractedTextView text={extracted.data.text} fileName={file.name} path={file.path} msg={extracted.data.msg} />
    } else if (extracted.status === 'unavailable') {
      body = <ConversionRequiredNote msg={extracted.error} />
    } else {
      body = <ErrorNote msg={extracted.error} />
    }
  } else if (converted.status === 'loading' || converted.status === 'warming') {
    // 첨부터 PDF 준비될 때까지 로딩 표시 (경과시간 포함). 로컬 파서는 폴백용으로만 둔다.
    body = <ConvertingView />
  } else if (converted.status === 'ready' && converted.data) {
    body = <PdfViewer data={converted.data} fileName={file.name} />
  } else if (isViewerOnly) {
    body = renderRawBody()
  } else if (converted.status === 'error' && converted.error && (pdfMode || !hasClientFallback)) {
    body = <ErrorNote msg={converted.error} />
  } else if (isOfficeNative && !pdfMode) {
    body = renderRawBody()
  } else if (hasClientFallback) {
    body = renderRawBody()
  } else {
    body = <ConversionRequiredNote msg={converted.error} />
  }

  return (
    <div className="h-full flex flex-col min-h-0 min-w-0 overflow-hidden">
      {isOfficeNative && !(editing && kind === 'pptx') && (
        <div
          className="flex items-center gap-2 px-3 py-1 border-b border-border bg-background flex-shrink-0"
          data-testid="preview-doc-header"
        >
          <div className="flex items-center rounded-md bg-muted p-0.5">
            <button
              type="button"
              onClick={() => { setPdfMode(false); void endEditing() }}
              className={`h-6 text-xs px-2 rounded ${!pdfMode ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              title="View directly without conversion"
            >
              View
            </button>
            <button
              type="button"
              onClick={() => { void endEditing(() => setPdfMode(true)) }}
              className={`h-6 text-xs px-2 rounded ${pdfMode ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              title="View as PDF converted on server"
            >
              Office(PDF)
            </button>
          </div>
          {(kind === 'pptx' || kind === 'docx' || kind === 'xlsx') && !pdfMode && (
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => {
                  if (editing) {
                    void endEditing()
                    return
                  }
                  setEditing(true)
                  // 편집은 전체화면으로 (전 문서 통일), 끝나면 채팅 자리로 복귀.
                  window.dispatchEvent(
                    new CustomEvent('fileFullscreenRequest', { detail: { isFullscreen: true } }),
                  )
                }}
                disabled={endingEdit}
                className={`h-6 text-xs px-2 rounded disabled:opacity-50 ${editing ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                title="Edit mode"
              >
                {endingEdit ? 'Saving…' : editing ? 'Done' : 'Edit'}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('officeSaveRequest'))}
                  className="h-6 text-xs px-2 rounded text-muted-foreground hover:text-foreground"
                  title="Overwrite current file"
                >
                  Save
                </button>
              )}
              {kind === 'docx' && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('docxCommentsToggle'))}
                  className="h-6 text-xs px-2 rounded text-muted-foreground hover:text-foreground"
                  title="Toggle comments panel"
                >
                  Comments
                </button>
              )}
              {kind === 'xlsx' && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('xlsxCommentsToggle'))}
                  // X1b(P1-2): 편집 모드는 항상 방에 참가한다 → 코멘트 저장은 방과 어긋나
                  // 조용히 사라진다. 편집 중에는 처음부터 비활성화하고 이유를 알려준다.
                  // X2a-③: 보기 모드라도 방에 편집자가 있으면 비활성화한다(같은 이유).
                  disabled={editing || xlsxRoomHasEditors}
                  className="h-6 text-xs px-2 rounded text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
                  title={
                    editing
                      ? '편집을 종료한 뒤 코멘트를 사용할 수 있습니다'
                      : xlsxRoomHasEditors
                        ? '편집자가 있어 보는 중에는 코멘트를 쓸 수 없습니다'
                        : 'Show comments'
                  }
                >
                  Comments
                </button>
              )}
              {kind === 'pptx' && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('pptxCommentsRequest'))}
                  className="h-6 text-xs px-2 rounded text-muted-foreground hover:text-foreground"
                  title="Show comments"
                >
                  Comments
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {body}
    </div>
  )
}

/** PDF 준비될 때까지 로딩 표시 (경과시간 포함 — 진짜 퍼센트는 변환기가 안 준다). */
function ConvertingView() {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t0 = Date.now()
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center px-6">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mb-2" />
      <p className="text-sm text-muted-foreground">PDF 변환 중… {secs}초</p>
      <p className="text-xs text-muted-foreground mt-1">첫 기동은 1분 정도 걸릴 수 있습니다</p>
    </div>
  )
}

function ConversionRequiredNote({ msg }: { msg?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center px-6">
      <AlertCircle className="w-6 h-6 text-muted-foreground mb-2" />
      <p className="text-sm text-muted-foreground">This document needs the conversion service (Microsoft Office) to preview.</p>
      {msg && <p className="text-xs text-destructive mt-1">{msg}</p>}
      <p className="text-xs text-muted-foreground mt-1">Start the backend, then reload the file.</p>
    </div>
  )
}

function parseMsgText(text: string): { from: string; to: string; cc: string; subject: string; date: string; body: string; isMsg: boolean } {
  const lines = text.split('\n')
  const fields: Record<string, string> = { from: '', to: '', cc: '', subject: '', date: '', body: '' }
  let sawHeader = false
  let bodyStart = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lower = line.toLowerCase()
    if (lower.startsWith('from:')) { fields.from = line.slice(5).trim(); sawHeader = true }
    else if (lower.startsWith('to:')) { fields.to = line.slice(3).trim(); sawHeader = true }
    else if (lower.startsWith('cc:')) { fields.cc = line.slice(3).trim(); sawHeader = true }
    else if (lower.startsWith('subject:')) { fields.subject = line.slice(8).trim(); sawHeader = true }
    else if (lower.startsWith('date:')) { fields.date = line.slice(5).trim(); sawHeader = true }
    else if (lower.startsWith('body:')) { bodyStart = i + 1; break }
  }
  fields.body = bodyStart >= 0 ? lines.slice(bodyStart).join('\n').trim() : ''
  return {
    from: fields.from,
    to: fields.to,
    cc: fields.cc,
    subject: fields.subject,
    date: fields.date,
    body: fields.body,
    isMsg: sawHeader,
  }
}

function MetaRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex items-center gap-1.5 text-muted-foreground w-16 flex-shrink-0 text-xs uppercase tracking-wide">
        {icon}
        <span>{label}</span>
      </span>
      <span className="text-sm text-foreground break-all leading-snug">{value}</span>
    </div>
  )
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

function ExtractedTextView({ text, fileName, path, msg }: { text: string; fileName?: string; path: string; msg?: ExtractedMsg }) {
  const parsed = useMemo(() => parseMsgText(text), [text])
  const attachments = msg?.attachments ?? []
  const hasHtml = !!msg?.html

  return (
    <DocumentShell fileName={fileName}>
      {(zoom) => (
        <div className="p-4" style={{ zoom }}>
          {parsed.isMsg ? (
            <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b-2 border-primary/20 bg-muted/40">
                <h2 className="text-base font-semibold text-foreground break-words">{parsed.subject || 'No subject'}</h2>
                {parsed.from && (
                  <p className="mt-1 text-sm text-muted-foreground">{parsed.from}</p>
                )}
              </div>
              <div className="px-5 py-3 border-b border-border text-sm space-y-1.5">
                {parsed.from && <MetaRow icon={<User className="w-3.5 h-3.5" />} label="From" value={parsed.from} />}
                {parsed.to && <MetaRow icon={<Users className="w-3.5 h-3.5" />} label="To" value={parsed.to} />}
                {parsed.cc && <MetaRow icon={<Users className="w-3.5 h-3.5" />} label="Cc" value={parsed.cc} />}
                {parsed.date && <MetaRow icon={<Clock className="w-3.5 h-3.5" />} label="Date" value={parsed.date} />}
              </div>
              {attachments.length > 0 && (
                <div className="px-5 py-3 border-b border-border">
                  <div className="flex items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wide mb-2">
                    <Paperclip className="w-3.5 h-3.5" />
                    <span>Attachments ({attachments.length})</span>
                  </div>
                  <ul className="space-y-1">
                    {attachments.map((a, i) => (
                      <li key={i}>
                        <a
                          href={`${API_BASE_URL}/api/preview/attachment?path=${encodeURIComponent(path)}&index=${i}`}
                          download={a.name}
                          className="flex items-center gap-2 rounded px-1.5 -mx-1.5 py-0.5 text-sm text-foreground hover:bg-muted/60 transition-colors"
                          title="Download attachment"
                        >
                          <File className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <span className="break-all">{a.name}</span>
                          <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">{formatSize(a.size)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="bg-white">
                {hasHtml ? (
                  <iframe
                    title="email body"
                    sandbox=""
                    referrerPolicy="no-referrer"
                    srcDoc={msg?.html}
                    className="w-full h-[600px] border-0"
                  />
                ) : parsed.body ? (
                  <div className="px-5 py-4 whitespace-pre-wrap break-words text-sm text-foreground/90 leading-relaxed">{parsed.body}</div>
                ) : (
                  <p className="px-5 py-4 text-sm text-muted-foreground italic">(No body)</p>
                )}
              </div>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-sm text-foreground font-mono leading-relaxed">{text}</pre>
          )}
        </div>
      )}
    </DocumentShell>
  )
}

function DocxViewer({ data, editing = false, path, fileName }: { data: ArrayBuffer; fileName?: string; editing?: boolean; path: string }) {
  const appTheme = useTheme()
  const baseContent = useMemo(() => new Uint8Array(data.slice(0)), [data])
  const [savedBytes, setSavedBytes] = useState<Uint8Array | null>(null)
  const content = savedBytes ?? baseContent
  const [handle, setHandle] = useState<{
    load: (b: Uint8Array) => Promise<void>
    save: () => Promise<Blob>
    markClean: () => void
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [laidOut, setLaidOut] = useState(0)
  const laidOutRef = useRef(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const relayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 사용자가 직접 건드린 뒤에는 우리 relayout이 stale 바이트로 되돌리면 안 된다.
  // lib 모델이 주인이므로 dirty 동안은 배치 건너뛰기.
  const [docDirty, setDocDirty] = useState(false)
  const onSavedDoc = useCallback((bytes: Uint8Array) => {
    setSavedBytes(new Uint8Array(bytes))
    setDocDirty(false)
  }, [])
  const { save } = useOfficeSave(path, fileName ?? 'document.docx', handle, onSavedDoc)
  const [comments, setComments] = useState<DocxComment[]>([])
  const [showComments, setShowComments] = useState(false)
  const [author, setAuthor] = useState(() => {
    try {
      // 저장된 값이 없으면 collab-user 이름을 처음 한 번만 기본값으로 가져온다.
      // TODO(v0.13): 저장된 이름이 collab 이름 변경을 따라가지 않는다. 입력칸 초기값을
      // collab-user에서 항상 읽도록 정리한다.
      return localStorage.getItem('docx-comment-author') ?? readCollabUser()?.name ?? ''
    } catch {
      return ''
    }
  })
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [deleteArm, setDeleteArm] = useState<string | null>(null)
  useEffect(() => {
    setSavedBytes(null)
  }, [data])
  // 파일 op 한 번: 편집 중이면 뷰어 모델을 먼저 파일에 굳히고(편집을 날리지 않기 위해),
  // op 적용 → 저장 → 패널 새로고침 순서로 처리한다 (뷰어는 content 변경으로 리로드).
  const mutateDocxComments = async (
    op: (base: Uint8Array) => Promise<Uint8Array>,
  ): Promise<boolean> => {
    try {
      let base = content
      if (editing) {
        if (!handle?.save) return false
        const blob: Blob = await handle.save()
        const cur = new Uint8Array(await blob.arrayBuffer())
        await saveOfficeBytes(path, fileName ?? 'document.docx', new Blob([cur as unknown as BlobPart]))
        base = cur
      }
      const next = await op(base)
      await saveOfficeBytes(path, fileName ?? 'document.docx', new Blob([next as unknown as BlobPart]))
      setSavedBytes(next)
      const cs = await loadDocxComments(next)
      setComments(cs)
      return true
    } catch (e) {
      showToast.error(e instanceof Error ? e.message : '코멘트 저장 실패')
      return false
    }
  }
  const commentAuthorName = () => {
    // 작성자 단일 통로: 입력값 → collab-user 이름. 가짜 기본값을 넣지 않는다.
    return author.trim() || readCollabUser()?.name?.trim() || ''
  }
  const addComment = async () => {
    const text = draft.trim()
    if (!text || adding) return
    const name = commentAuthorName()
    if (!name) {
      showToast.error('작성자 이름을 입력하세요')
      return
    }
    setAdding(true)
    try {
      const ok = await mutateDocxComments((base) =>
        addDocxComment(base, { authorName: name, text }),
      )
      if (!ok) return
      setDraft('')
      try {
        localStorage.setItem('docx-comment-author', name)
      } catch {
        /* 무시 */
      }
      showToast.success('코멘트 저장했습니다')
    } finally {
      setAdding(false)
    }
  }
  const sendReply = async (c: DocxComment) => {
    const text = replyDraft.trim()
    if (!text || busyId || !c.cid) return
    const name = commentAuthorName()
    if (!name) {
      showToast.error('작성자 이름을 입력하세요')
      return
    }
    setBusyId(`reply:${c.cid}`)
    try {
      const ok = await mutateDocxComments((base) =>
        replyDocxComment(base, { parentCid: c.cid, authorName: name, text }),
      )
      if (ok) {
        setReplyTo(null)
        setReplyDraft('')
        showToast.success('답글 저장했습니다')
      }
    } finally {
      setBusyId(null)
    }
  }
  const toggleResolve = async (c: DocxComment) => {
    if (busyId || !c.cid) return
    setBusyId(`resolve:${c.cid}`)
    try {
      await mutateDocxComments((base) => setDocxCommentDone(base, { cid: c.cid, done: !c.resolved }))
    } finally {
      setBusyId(null)
    }
  }
  const saveEdit = async (c: { cid: string }) => {
    const text = editDraft.trim()
    if (!text || busyId) return
    setBusyId(`edit:${c.cid}`)
    try {
      await mutateDocxComments((base) => editDocxComment(base, { cid: c.cid, text }))
      setEditingId(null)
    } finally {
      setBusyId(null)
    }
  }
  const doDelete = async (c: { cid: string }) => {
    if (busyId || !c.cid) return
    if (deleteArm !== c.cid) {
      setDeleteArm(c.cid)
      return
    }
    setDeleteArm(null)
    setBusyId(`delete:${c.cid}`)
    try {
      await mutateDocxComments((base) => deleteDocxComment(base, c.cid))
    } finally {
      setBusyId(null)
    }
  }
  // 편집 중 노드가 다시 그려지면 오버레이가 날아가서 다시 맞춘다.
  // 단 사용자가 모델을 건드린 뒤(dirty)에는 stale 바이트로 되돌리면 안 된다.
  const scheduleRelayout = () => {
    if (docDirty) return
    if (!laidOutRef.current || !wrapRef.current) return
    if (relayoutTimer.current) clearTimeout(relayoutTimer.current)
    relayoutTimer.current = setTimeout(() => {
      if (wrapRef.current) void layoutAnchoredTextBoxes(content, wrapRef.current)
    }, 500)
  }
  useEffect(() => () => {
    if (relayoutTimer.current) clearTimeout(relayoutTimer.current)
  }, [])

  useEffect(() => {
    if (!handle) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // 편집 모드에서는 저장 거부하는 인라인 OOXML을 미리 정리한다 (보기 모드는 원본).
    void (editing ? sanitizeDocxForEdit(content) : Promise.resolve(content))
      .then((bytes) => {
        if (cancelled) return
        // 선택된 상자가 보이게 (ProseMirror 선택 링).
        const sr = wrapRef.current?.querySelector('docx-editor')?.shadowRoot
        if (sr && !sr.querySelector('[data-anchor-ring]')) {
          const st = document.createElement('style')
          st.setAttribute('data-anchor-ring', '1')
          st.textContent =
            '.dve-paper .dve-image-placeholder.ProseMirror-selectednode{' +
            'outline:2px solid var(--word,#2b579a);outline-offset:1px}'
          sr.appendChild(st)
        }
        return handle.load(bytes)
      })
      .then(() => {
        // 로드 직후 모델은 깨끗하다 (이전 dirty 잔재 무시).
        setDocDirty(false)
        // 렌더가 자리 잡은 뒤 떠있는 텍스트상자를 앵커 좌표에 배치한다 (보기/편집 공통).
        timer = setTimeout(() => {
          if (cancelled || !wrapRef.current) return
          void layoutAnchoredTextBoxes(content, wrapRef.current).then((n) => {
            if (!cancelled) {
              setLaidOut(n)
              laidOutRef.current = n
            }
          })
        }, 350)
        // 코멘트 목록은 미리 읽어둔다 (패널은 기본 닫힘, 토글로 연다).
        void loadDocxComments(content).then((cs) => {
          if (cancelled) return
          setComments(cs)
        })
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [handle, content, editing])

  useEffect(() => {
    setError(null)
    setLaidOut(0)
    laidOutRef.current = 0
    setDocDirty(false)
  }, [data])

  // 리플로우(리사이즈·줌·편집 변경)되면 앵커 배치를 다시 맞춘다.
  // dirty 동안은 lib 모델이 주인이라 건드리지 않는다.
  useEffect(() => {
    if (!laidOut || !wrapRef.current) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const relayout = () => {
      if (docDirty) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (wrapRef.current) void layoutAnchoredTextBoxes(content, wrapRef.current)
      }, 400)
    }
    const ro = new ResizeObserver(relayout)
    ro.observe(wrapRef.current)
    return () => {
      ro.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [laidOut, content, editing, docDirty])

  // 코멘트가 있으면 목록 패널을 같이 열어준다 (보기/편집 공통).
  useEffect(() => {
    let dead = false
    setComments([])
    setShowComments(false)
    void loadDocxComments(content).then((cs) => {
      if (dead) return
      setComments(cs)
    })
    return () => {
      dead = true
    }
  }, [content])

  // 상단 코멘트 버튼: 우측 목록 패널을 여닫는다.
  useEffect(() => {
    const onToggle = () => {
      setShowComments((v) => !v)
    }
    window.addEventListener('docxCommentsToggle', onToggle)
    return () => window.removeEventListener('docxCommentsToggle', onToggle)
  }, [])

  // 뷰어 툴바 저장 가로채기 (기본 다운로드를 막고 제자리 저장) + 상단 저장 버튼.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onFileCommand = (e: Event) => {
      const cmd = (e as CustomEvent<{ command?: string }>).detail?.command
      if (cmd === 'save') {
        e.preventDefault()
        void save()
      }
    }
    el.addEventListener('file-command', onFileCommand)
    return () => el.removeEventListener('file-command', onFileCommand)
  }, [save, editing])
  // B1(b): officeSaveRequest는 window 전역이다. 편집이 아닐 때 듣으면 편집 진입 전이나
  // 보기 화면에서 떠오른 저장이 XLSX 편집 세션과 엮인다. 편집 중에만 등록한다.
  useEffect(() => {
    if (!editing) return
    const onSave = () => {
      void save()
    }
    window.addEventListener('officeSaveRequest', onSave)
    return () => window.removeEventListener('officeSaveRequest', onSave)
  }, [save, editing])

  // 조건부 early-return보다 뒤에 hook이 오면 렌더마다 hook 개수가 달라져
  // React #300("fewer hooks than expected")으로 터진다. error 분기는 모든
  // hook 뒤(최종 return 직전)에서 처리한다.
  const refreshDocxComments = useCallback(async () => {
    try {
      const cs = await loadDocxComments(content)
      setComments(cs)
    } catch {
      /* 무시 */
    }
  }, [content])
  if (error) return <ErrorNote msg={error} />
  return (
    <EngineHost className="docxengine-host h-full min-h-[480px]">
      <div className="flex h-full min-h-0">
        <div ref={wrapRef} key={editing ? 'edit' : 'view'} className="flex-1 min-w-0 h-full">
          <Suspense fallback={SPINNER}>
            <WordEditor
              ref={setHandle}
              readOnly={!editing}
              showToolbar={editing}
              theme={appTheme}
              onDocumentChange={scheduleRelayout}
              onDirtyChange={setDocDirty}
              onDocumentError={(e) => setError(e instanceof Error ? e.message : String(e))}
            />
          </Suspense>
        </div>
        {showComments && (
          <div data-docx-comments className="w-72 shrink-0 border-l border-border bg-background flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-border text-xs font-medium flex-shrink-0 flex items-center gap-1">
              <span className="flex-1">코멘트 ({comments.length})</span>
              <button
                type="button"
                onClick={() => void refreshDocxComments()}
                className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                title="다시 읽기"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
            <div className="p-2 border-b border-border flex-shrink-0 space-y-1.5">
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="이름"
                className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
              />
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="코멘트 입력 (문서 앞부분)"
                rows={2}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
              />
              <Button
                size="sm"
                className="w-full h-7 text-xs"
                disabled={!draft.trim() || adding}
                onClick={() => void addComment()}
              >
                {adding ? '저장 중…' : '코멘트 저장'}
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
              {comments.length === 0 && (
                <p className="text-xs text-muted-foreground px-1">코멘트 없음</p>
              )}
              {comments.map((c, i) => (
                <div
                  key={`${c.cid || i}`}
                  className="rounded-md border border-border/60 p-2"
                >
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="truncate flex-1">{c.anchor || '문서 앞부분'}</span>
                    {c.resolved && <span className="shrink-0">· 해결됨</span>}
                  </div>
                  <div className="text-xs font-medium mt-0.5">{c.author}</div>
                  {editingId === c.cid ? (
                    <div className="mt-0.5" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
                      />
                    </div>
                  ) : (
                    <div className="text-xs whitespace-pre-wrap break-words mt-0.5">{c.text}</div>
                  )}
                  {c.replies.map((r, j) => (
                    <div key={j} className="mt-1.5 pl-2 border-l-2 border-border">
                      <div className="text-xs font-medium">{r.author}</div>
                      {editingId === r.cid ? (
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={2}
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none mt-0.5"
                        />
                      ) : (
                        <div className="text-xs whitespace-pre-wrap break-words">{r.text}</div>
                      )}
                      {r.cid && (
                        <div className="flex items-center gap-0.5 mt-1">
                          <XlsxIconBtn
                            title="수정"
                            onClick={() => {
                              setEditingId(r.cid)
                              setEditDraft(r.text)
                              setReplyTo(null)
                              setDeleteArm(null)
                            }}
                          >
                            <Pencil className="w-3 h-3" />
                          </XlsxIconBtn>
                          <XlsxIconBtn
                            title={deleteArm === r.cid ? '확인: 삭제' : '삭제'}
                            danger={deleteArm === r.cid}
                            onClick={() => void doDelete({ cid: r.cid })}
                          >
                            {deleteArm === r.cid ? <Check className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                          </XlsxIconBtn>
                          {editingId === r.cid && (
                            <>
                              <XlsxIconBtn title="저장" onClick={() => void saveEdit({ cid: r.cid })}>
                                <Check className="w-3 h-3" />
                              </XlsxIconBtn>
                              <XlsxIconBtn title="취소" onClick={() => setEditingId(null)}>
                                <X className="w-3 h-3" />
                              </XlsxIconBtn>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {replyTo === c.cid && c.cid && (
                    <div className="mt-1.5 space-y-1" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        value={replyDraft}
                        onChange={(e) => setReplyDraft(e.target.value)}
                        placeholder="답글 입력"
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
                      />
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          className="h-6 text-[11px] flex-1"
                          disabled={!replyDraft.trim() || !!busyId}
                          onClick={() => void sendReply(c)}
                        >
                          답글 저장
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px]"
                          onClick={() => {
                            setReplyTo(null)
                            setReplyDraft('')
                          }}
                        >
                          취소
                        </Button>
                      </div>
                    </div>
                  )}
                  {editingId === c.cid && c.cid && (
                    <div className="flex items-center gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        className="h-6 text-[11px] flex-1"
                        disabled={!editDraft.trim() || !!busyId}
                        onClick={() => void saveEdit(c)}
                      >
                        저장
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => setEditingId(null)}
                      >
                        취소
                      </Button>
                    </div>
                  )}
                  {c.cid && (
                    <div className="flex items-center gap-0.5 mt-1.5">
                      <XlsxIconBtn
                        title="답글"
                        onClick={() => {
                          setReplyTo(replyTo === c.cid ? null : c.cid)
                          setReplyDraft('')
                          setEditingId(null)
                          setDeleteArm(null)
                        }}
                      >
                        <Reply className="w-3 h-3" />
                      </XlsxIconBtn>
                      <XlsxIconBtn
                        title="수정"
                        onClick={() => {
                          setEditingId(c.cid)
                          setEditDraft(c.text)
                          setReplyTo(null)
                          setDeleteArm(null)
                        }}
                      >
                        <Pencil className="w-3 h-3" />
                      </XlsxIconBtn>
                      <XlsxIconBtn
                        title={c.resolved ? '미해결로' : '해결됨으로'}
                        onClick={() => void toggleResolve(c)}
                      >
                        {c.resolved ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                      </XlsxIconBtn>
                      <XlsxIconBtn
                        title={deleteArm === c.cid ? '확인: 삭제' : '삭제'}
                        danger={deleteArm === c.cid}
                        onClick={() => void doDelete(c)}
                      >
                        {deleteArm === c.cid ? <Check className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                      </XlsxIconBtn>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </EngineHost>
  )
}

function OfficeVisioViewer({ data }: { data: ArrayBuffer; fileName?: string }) {
  const content = useMemo(() => new Uint8Array(data.slice(0)), [data])
  const [handle, setHandle] = useState<{ load: (b: Uint8Array) => Promise<void> } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!handle) return
    let cancelled = false
    handle.load(content).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      cancelled = true
    }
  }, [handle, content])

  useEffect(() => {
    setError(null)
    setHandle(null)
  }, [data])

  if (error) return <ErrorNote msg={error} />
  return (
    <EngineHost className="visioengine-host h-full min-h-[480px]">
      <Suspense fallback={SPINNER}>
        <VisioViewer
          ref={setHandle}
          showToolbar={false}
        />
      </Suspense>
    </EngineHost>
  )
}

function XlsxIconBtn({
  title,
  danger,
  onClick,
  children,
}: {
  title: string
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted ${
        danger ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function XlsxViewer({ data, fileName, editing = false, path, etag: etagProp, onRoomHasEditorsChange, onRequestReload }: { data: ArrayBuffer; fileName?: string; editing?: boolean; path: string; etag?: string | null; onRoomHasEditorsChange?: (has: boolean) => void; onRequestReload?: () => void }) {
  const appTheme = useTheme()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const baseContent = useMemo(() => new Uint8Array(data.slice(0)), [data])
  const [savedBytes, setSavedBytes] = useState<Uint8Array | null>(null)
  const content = savedBytes ?? baseContent
  const [xlsxHandle, setXlsxHandle] = useState<{
    save: () => Promise<Blob>
    markClean: () => void
    saveBytes?: (format?: 'xlsx' | 'csv') => Promise<Uint8Array>
    select?: (ref: string) => void
    setActiveSheet?: (index: number) => void
    getSelection?: () => string
    /** C3: 범위로 스크롤만 한다(선택은 바꾸지 않는다). lib 패치. */
    reveal?: (ref: string) => void
    /** C1: 참가자 표시용 신원 갱신 (빈 이름이면 false).
     * C4-3: sheet/range까지 넘기면 presence 셀 표시를 지운다
     * (이미지 선택 시 내 셀 잔상 제거. lib 패치 updateCollabIdentity 확장). */
    updateCollabIdentity?: (patch: { name?: string; color?: string; sheet?: string | null; range?: string | null }) => boolean
  } | null>(null)
  const listenRef = useRef<HTMLDivElement>(null)
  // X1c(P0): 단독 저장의 잠금 ETag. 파일을 **읽은 시점**의 값부터 시작해,
  // 단독 저장 성공마다 서버가 돌려준 새 ETag 로 갱신한다(디스크와 동기화 유지).
  const [etag, setEtag] = useState<string | null>(null)
  useEffect(() => {
    setEtag(etagProp ?? null)
  }, [etagProp])
  const { save: saveSoloBase } = useOfficeSave(path, fileName ?? 'workbook.xlsx', xlsxHandle, (_bytes, nextEtag) => {
    if (nextEtag) setEtag(nextEtag)
  }, {
    // X1c(P0): 단독 저장도 잠근다(디스크가 원본). 파일을 **읽은 시점**의 ETag,
    // 단독 저장 성공마다 갱신한다.
    ifMatch: etag,
    requireIfMatch: true,
    onError: (_conflict, e) => {
      // X1c(P0-2): 모든 저장 실패에 내 사본 다운로드를 제공한다(토스트만으로는 조용한 유실이다).
      void storeFailedBytes(e)
    },
  })
  // X1b: XLSX 동시편집. 편집 중이면 방에 참가하고, 저장은 **방을 아는 경로**로 한다.
  //  - lib(ooxml-ui xlsx)이 방(Yjs)·presence·문서 공유를 소유한다. 앱은 배선만 한다.
  //  - 저장은 `/api/collab/save`(낙관적 잠금) 로 통일한다: 방의 해시가 갱신되고,
  //    외부 변경(AI 편집·보기 모드 코멘트)으로는 덮어쓰지 않는다.
  const [collab, setCollab] = useState<{
    roomId: string
    baseHash: string
    /** C4: 방 재생성(orphan dispose)을 감지한다 — epoch이 바뀌면 개체 표를 다시 등록한다. */
    epoch: string
    serverUrl: string
    user: { name: string; color: string; id?: string; role?: 'collaborator' | 'viewer' }
    /** X2a-③: 참가 역할. 보기 모드도 방에 참가한다(presence만, 문서는 방이 이긴다). */
    role: 'edit' | 'viewer'
    /**
     * X1c(P1): lib 이 방에 붙고 문서를 적용했는가. false 동안은 편집기를 열지 않는다
     * (마운트 직후의 입력이 "방의 문서가 이긴다" 규칙으로 사라진다).
     */
    joined: boolean
  } | null>(null)
  // X1d: notice 종류에 'timeout'(연결 대기 상한)을 추가한다.
  const [collabNotice, setCollabNotice] = useState<{ kind: 'stale' | 'noetag' | 'error' | 'external' | 'timeout'; text: string } | null>(null)
  const [conflictBytes, setConflictBytes] = useState<Uint8Array | null>(null)
  /**
   * X1c(P1): 방 참가 판정(collab 또는 notice)이 끝날 때까지 편집기를 readOnly로 막는다.
   * 마운트 시 방에 붙으면 "방의 문서가 이긴다" 규칙 때문에 먼저 입력이 사라질 수 있다.
   *
   * X1d(P0): 연결 대기에는 상한이 있다(15초). lib 가 `active` 를 알려줘야 readOnly 가
   * 풀리므로, VPN/프록시 등으로 WebSocket 이 막힌 환경에서는 영원히 막힌다. 초과하면
   * 보기 전용으로 두고 배너("연결 시간 초과") + "다시 연결"을 띄운다(C2-b).
   */
  const joining = !collabNotice && !(collab?.joined)
  // X2a-③ 후속: viewer 로 붙어 있어도 편집 잠금은 풀지 않는다. 편집 입력은
  // editor 역할 세션이 방에 붙고 문서를 적용한 뒤에만 받는다(viewer→editor 전환
  // 사이 leave/rejoin 구간에 입력하면 "방의 문서가 이긴다"로 조용히 사라진다).
  const connecting = editing && !collabNotice && !(collab?.role === 'edit' && collab?.joined)
  const editingRef = useRef(editing)
  editingRef.current = editing
  /** X2a-③: viewer가 방 내용을 따라가도록 에디터를 다시 마운트한 세대. key 에 들어간다. */
  const [viewerGen, setViewerGen] = useState(0)
  /** C2-a: "다시 연결" 재시도 트리거. */
  const [joinKey, setJoinKey] = useState(0)
  /** C2-a: ETag를 끝내 못 받으면 보기 전용으로 둔다(단독 편집 금지). */
  const [forceViewOnly, setForceViewOnly] = useState(false)
  /** C2-a: ETag 누락 시 부모 재수신 1회 + 재시도 타이머. */
  const etagRetryRef = useRef(false)
  /** C2-b: stale_client 재수신 1회 플래그. */
  const staleRetryRef = useRef(false)
  /** C2-c: 자동 저장 디바운스 타이머 + 중복 실행 가드. */
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autosaveInFlightRef = useRef(false)
  /** C3: 자동 저장 예약 중 플래그 (1→2 만났을 때 즉시 저장 판단용). */
  const autosavePendingRef = useRef(false)
  /**
   * C4: 시트 개체 표(서버가 진실). people과 무관하게 방 단위로 유지한다.
   * key -> {sheet, kind, anchor, deleted, version, lock}.
   */
  const objTableRef = useRef(new Map<string, { sheet: number; kind: string; anchor: unknown; deleted: boolean; version: number; lock: { clientId: number; lockId: string; expiresAt: number } | null }>())
  const objVersionRef = useRef(0)
  /** C4: 키 대응 실패 시 그 세션의 개체 op를 전부 막는다 (fail-closed). */
  const objMismatchRef = useRef(false)
  /** C4: pointerdown으로 잡은 개체 키 (가드 activeKey 판정용). */
  const objActiveKeyRef = useRef<string | null>(null)
  /**
   * C4-3: 개체 pointerdown 당시 셀 선택 스냅샷. lib은 개체 클릭에도
   * 클릭 전과 같은 선택으로 selection-change 에코를 쏘는데, 이 에코에
   * 막 잡은 락을 풀면 안 된다. detail이 스냅샷과 같으면 에코(무시),
   * 다르면 진짜 셀 이동(락 해제)이다.
   */
  const objGrabSelRef = useRef<{ sheet: number; ref: string } | null>(null)
  /** C4: 마지막으로 서버에 보낸(또는 서버에서 받은) 상태. 메아리 방지 기준점. */
  const objLastSentRef = useRef(new Map<string, { anchor: string; deleted: boolean }>())
  /** C4: 원격 적용 중에는 스냅샷 송신을 건너뛴다. */
  const applyingRemoteRef = useRef(false)
  /** C4: 개체 토스트 마지막 표시 (문구별 2초 내 중복 방지). */
  const objToastLastRef = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  /** C4: 개체 변경 수신기 (서버 브로드캐스트 type 102). */
  const objOnMessageRef = useRef<((msg: ObjectsStateMsg) => void) | null>(null)
  /** C4: 탭 transport (재)연결 때마다 놓친 브로드캐스트를 GET으로 따라잡는다. */
  const objConnectRef = useRef<(() => void) | null>(null)
  /** C4: 서버 거부 후 되돌리기용 undo/redo는 가드를 우회한다 (사용자 경로 아님). */
  const objUndoRevertRef = useRef(false)
  /** C4: 현재 보고 있는 시트 (sheet-change 이벤트로 추적). */
  const objActiveSheetRef = useRef(0)
  const joinAgainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onReloadFileRef = useRef(onRequestReload)
  onReloadFileRef.current = onRequestReload
  const selfClientIdRef = useRef<number | null>(null)
  const [xlsxPeople, setXlsxPeople] = useState<XlsxPresencePerson[]>([])
  const xlsxPeopleRef = useRef<XlsxPresencePerson[]>([])
  xlsxPeopleRef.current = xlsxPeople
  /** C3: 동시편집 잠금. 방에 붙어 있고 나 포함 2명 이상이면 켠다(탭·viewer 포함). */
  const collabLocked = !!collab?.joined && xlsxPeople.length >= 2
  const collabLockedRef = useRef(collabLocked)
  collabLockedRef.current = collabLocked
  /** C4-3: 따라가는 상대 묶음 id("u:…"/"c:…"). setActiveSheet로만 이동한다(select 금지). */
  const [xlsxFollowId, setXlsxFollowId] = useState<string | null>(null)
  /**
   * C3: 따라가기 해제 조건. 시트 직접 조작만 해제한다.
   * 시트 탭·툴바·팝오버 같은 UI 크롬 조작은 유지한다 (P-7c 상호 팔로우).
   */
  const isFollowUiTarget = (t: unknown): boolean => {
    const el = t as HTMLElement | null
    if (!el || typeof el.closest !== 'function') return false
    return !!el.closest('aside, [role="navigation"], [role="toolbar"], [data-testid="collab-popover"], [data-testid="collab-avatars"]')
  }
  /** C1: 팔로우 이동(프로그램 이동) 중에는 이동 콜백을 제외한다. */
  const followNavigatingRef = useRef(false)
  const hadEditorsRef = useRef(false)
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * X1d(P0): 연결 대기 상한(15초). 초과하면 보기 전용 + "다시 연결"(C2-b).
   * 서버가 살아 있는데 단독 편집으로 넘어가면 방과 갈라지므로 금지한다.
   * X2a-③: 보기 모드도 같은 상한을 쓴다(텍스트만 viewing 용).
   */
  useEffect(() => {
    if (!joining) return
    // X2a-③ 후속: 모드가 바뀌면(보기→편집) 대기 시간을 처음부터 잰다. 미리보기 단계에서
    // 돌던 타이머가 편집 참가 중에 터지면 notice 가 박혀 배너가 안 보인다(부하 시 관측).
    const t = setTimeout(() => {
      // X2a-④ 후속: viewer 는 늦게 붙어도 안전하므로(쓰기 없음) 세션을 자르지 않는다.
      // 안내만 띄우고 참가가 되면 그대로 쓴다. 저속 환경에서 15초를 넘기면 세션을
      // 잘라버려 이후 저장이 solo 로 빠지는 문제를 막는다(msedge 저부하 관측).
      // 편집 모드는 solo 전환을 위해 자른다(늦은 참가가 덮어쓸 수 있다).
      if (!editingRef.current) {
        setCollabNotice({
          kind: 'timeout',
          text: '실시간 보기 연결이 느립니다 — 파일만 보여줍니다',
        })
        return
      }
      setCollab(null)
      // C2-b: 상한을 넘기면 보기 전용으로 둔다(서버가 살아 있는데 단독 편집하면 방과 갈라진다).
      setForceViewOnly(true)
      setCollabNotice({
        kind: 'timeout',
        text: '동시편집 연결 시간 초과 — 보기 전용으로 둡니다. 다시 연결해 보세요',
      })
    }, 15000)
    return () => clearTimeout(t)
  }, [joining, editing])
  const collabRef = useRef(collab)
  collabRef.current = collab
  /** C4: lib 연결 상태 (offline이면 개체 op를 막는다 — 락 강제 불가이므로 fail-closed). */
  const connOnlineRef = useRef(true)
  const onRoomHasEditorsChangeRef = useRef(onRoomHasEditorsChange)
  onRoomHasEditorsChangeRef.current = onRoomHasEditorsChange
  const xlsxHandleRef = useRef(xlsxHandle)
  xlsxHandleRef.current = xlsxHandle
  /**
   * C3: React 래퍼 ref(O())는 구 API 부분집합이라 reveal/updateCollabIdentity가 없다
   * (?. 로 조용히 스킵되어 이름 변경·따라가기 스크롤이 먹통이었다).
   * element(패치된 xlsx-editor)에 있으면 위임으로 채운다. 인라인 ref 콜백은 매 렌더
   * detach/attach를 유발하므로 effect에서 1회만 보정한다.
   */
  useEffect(() => {
    if (!xlsxHandle) return
    try {
      const el = (xlsxHandle as unknown as { element?: unknown }).element as
        | {
            reveal?: (ref: string) => void
            updateCollabIdentity?: (p: { name?: string; color?: string; sheet?: string | null; range?: string | null }) => boolean
          }
        | undefined
      if (!el) return
      const rec = xlsxHandle as unknown as Record<string, unknown>
      if (typeof rec.reveal !== 'function' && typeof el.reveal === 'function') {
        const fn = el.reveal.bind(el)
        rec.reveal = (ref: string) => fn(ref)
      }
      if (typeof rec.updateCollabIdentity !== 'function' && typeof el.updateCollabIdentity === 'function') {
        const fn = el.updateCollabIdentity.bind(el)
        rec.updateCollabIdentity = (p: { name?: string; color?: string; sheet?: string | null; range?: string | null }) => fn(p)
      }
    } catch {
      /* 무시 */
    }
  }, [xlsxHandle])
  /**
   * C1: 다른 뷰어(같은 탭의 PPT 바 등)에서 신원을 바꾸면 lib 세션 신원도 갱신한다.
   * updateCollabIdentity는 identity 원본을 고치고 presence로 즉시 알린다(빈 이름 저장 금지).
   */
  useEffect(() => {
    const onUserChanged = (): void => {
      try {
        const me = readCollabUser()
        if (!me) return
        xlsxHandleRef.current?.updateCollabIdentity?.({ name: me.name, color: me.color })
      } catch {
        /* 무시 */
      }
    }
    window.addEventListener('collab-user-changed', onUserChanged)
    return () => window.removeEventListener('collab-user-changed', onUserChanged)
  }, [])
  /** C3: 팔로우 — 따라가는 상대의 시트로 이동하고 범위로 스크롤한다.
   * - select()는 쓰지 않는다(내 선택을 바꾸면 상대 화면에 내 커서가 튀고 루프가 된다).
   * - setActiveSheet로 시트를 옮기고 reveal()로 스크롤만 한다.
   * - 프로그램 이동 중(followNavigatingRef)에는 이동 콜백을 제외한다.
   * - C4-3: 묶음 id("u:…"/"c:…")로 따라간다. 같은 userId 탭이 여러 개면
   *   시트 정보가 있는 탭을 우선 따라간다.
   */
  const followTarget = xlsxFollowId == null
    ? undefined
    : (() => {
        // C4-3: 묶음 id("u:…"/"c:…")로 찾는다. 시트 정보가 있는 탭을 우선 따라간다.
        const sibs = xlsxPeople.filter((p) => {
          if (p.self) return false
          const k = typeof p.userId === 'string' && p.userId ? `u:${p.userId}` : `c:${p.clientId}`
          return k === xlsxFollowId
        })
        const withSheet = sibs.find((p) => typeof p.sheetIndex === 'number') ?? sibs[0]
        if (!withSheet || typeof withSheet.sheetIndex !== 'number') return undefined
        return {
          sheetIndex: withSheet.sheetIndex,
          range: typeof withSheet.range === 'string' ? withSheet.range : undefined,
        }
      })()
  const followSheetIndex = followTarget?.sheetIndex
  const followRange = followTarget?.range
  // C3: 마지막으로 따라간 목표. 500ms 창 안에 들어온 연속 이동이
  // followNavigatingRef 조기 반환에 삼켜져 유실되므로 목표로 중복을 가린다.
  // 핸들이 바뀌면(리마운트) 같은 목표라도 다시 따라간다(스크롤이 초기화되므로).
  const lastXlsxFollowNavRef = useRef<{ handle: unknown; key: string | null }>({ handle: null, key: null })
  useEffect(() => {
    if (xlsxFollowId == null || typeof followSheetIndex !== 'number') {
      if (xlsxFollowId == null) lastXlsxFollowNavRef.current = { handle: lastXlsxFollowNavRef.current.handle, key: null }
      return
    }
    const key = `${xlsxFollowId}|${followSheetIndex}|${followRange ?? ''}`
    const last = lastXlsxFollowNavRef.current
    if (last.handle === xlsxHandleRef.current && last.key === key) return
    lastXlsxFollowNavRef.current = { handle: xlsxHandleRef.current, key }
    followNavigatingRef.current = true
    try {
      xlsxHandleRef.current?.setActiveSheet?.(followSheetIndex)
      if (followRange) xlsxHandleRef.current?.reveal?.(followRange)
    } catch {
      /* 무시 */
    }
    ;(window as unknown as { __c3FollowNav?: number }).__c3FollowNav =
      ((window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0) + 1
    const t = setTimeout(() => {
      followNavigatingRef.current = false
    }, 500)
    return () => clearTimeout(t)
  }, [xlsxFollowId, followSheetIndex, followRange, xlsxHandle])
  /**
   * X1c(P0-2): 실패한 저장 바이트를 한 개만 보관한다(D27).
   * 어떤 실패(외부 변경·방 없음·네트워크·413·재시도 실패)든 사용자가 내려받을 수 있어야 한다.
   */
  const storeFailedBytes = useCallback(async (e: unknown): Promise<void> => {
    try {
      const handle = xlsxHandleRef.current
      if (!handle?.saveBytes) return
      setConflictBytes(new Uint8Array(await handle.saveBytes()))
    } catch {
      /* 바이트를 못 얻으면 다운로드 제공만 안 된다(토스트로 끝). */
    }
    void e
  }, [])
  /** C2-a: ETag 재수신 + 방 재참가. */
  const reconnectCollab = useCallback(() => {
    etagRetryRef.current = false
    staleRetryRef.current = false
    setForceViewOnly(false)
    setCollabNotice(null)
    onReloadFileRef.current?.()
    setJoinKey((k) => k + 1)
  }, [])
  useEffect(() => {
    // X2a-③: 보기 모드도 방에 참가한다(viewer 역할, presence만 공유).
    // 모드가 바뀌면 viewer 따라가기 상태도 처음부터 다시 본다.
    hadEditorsRef.current = false
    onRoomHasEditorsChangeRef.current?.(false)
    // X2a-③ 후속: 모드 전환 시 이전 단계의 세션·안내를 먼저 비운다. 미리보기 단계에서
    // 생긴 notice/timeout 이 편집 참가 배너를 가리면 입력 차단 증명이 깨진다(부하 시 관측).
    // lib 도 collaboration=undefined 로 즉시 방에서 나간다.
    setCollab(null)
    setCollabNotice(null)
    if (recheckTimer.current) {
      clearTimeout(recheckTimer.current)
      recheckTimer.current = null
    }
    setConflictBytes(null)
    const role = editing ? 'edit' : 'viewer'
    let dead = false
    void (async () => {
      // C2-a: knownHash는 서버가 준 ETag(바이트와 같은 응답). subtle 계산 없음.
      // 따옴표가 감싸여 오면 벗긴다(If-Match 비교와 같은 규칙).
      const rawTag = (etagProp ?? '').replace(/^"|"$/g, '')
      if (!rawTag) {
        // ETag가 없으면 파일을 한 번 다시 받는다. 그래도 없으면 보기 전용으로 두고
        // "다시 연결" 버튼을 띄운다(단독 편집으로 넘어가지 않는다).
        // 다른 join 시도가 복구 중이면(타이머 대기) 조용히 둔다. 재시도 rerun이 판정한다.
        if (joinAgainTimerRef.current) {
          return
        }
        if (!etagRetryRef.current) {
          etagRetryRef.current = true
          onReloadFileRef.current?.()
          // etag prop이 바뀌면 effect가 다시 돈다. 바뀌지 않아도 타이머가 한 번 더 돌린다.
          joinAgainTimerRef.current = setTimeout(() => {
            joinAgainTimerRef.current = null
            setJoinKey((k) => k + 1)
          }, 4000)
        } else if (!dead) {
          setCollab(null)
          setForceViewOnly(true)
          setCollabNotice({
            kind: 'noetag',
            text: editing
              ? '파일 정보를 확인하지 못했습니다 — 보기 전용으로 둡니다. 다시 연결하면 동시편집에 참가합니다'
              : '파일 정보를 확인하지 못했습니다 — 파일만 보여줍니다. 다시 연결해 보세요',
          })
        }
        return
      }
      const knownHash = rawTag
      try {
        // 2) 서버가 staleness 를 판정한다(P0-2, viewer도 strict).
        const info = await collabApi.session(path, { knownHash, strict: true })
        if (dead) return
        if (info.stale) {
          // C2-b: stale_client는 파일을 다시 받아서 1회 재참가한다.
          // 다른 join 시도가 복구 중이면(타이머 대기) 조용히 둔다. 재시도 rerun이 판정한다.
          if (joinAgainTimerRef.current) {
            return
          }
          if (info.code === 'stale_client' && !staleRetryRef.current) {
            staleRetryRef.current = true
            onReloadFileRef.current?.()
            // etag prop이 바뀌면 effect가 다시 돈다. 바뀌지 않아도 타이머가 한 번 더 돌린다.
            joinAgainTimerRef.current = setTimeout(() => {
              joinAgainTimerRef.current = null
              setJoinKey((k) => k + 1)
            }, 4000)
            return
          }
          // C2-b: stale_room인데 방이 살아 있으면 strict 없이 참가해 방 내용을 따라간다.
          // (빈 방은 서버가 디스크 기준으로 리셋했으므로 stale이 오지 않는다.)
          if (info.code === 'stale_room') {
            try {
              const info2 = await collabApi.session(path)
              if (dead) return
              if (!info2.stale) {
                const me = readCollabUser()
                setForceViewOnly(false)
                setCollab({
                  roomId: info2.roomId,
                  baseHash: info2.lastHash,
                  epoch: info2.epoch ?? '',
                  serverUrl: collabServerUrl(),
                  user: {
                    name: me?.name?.trim() || 'user',
                    color: me?.color || '#2563eb',
                    id: me?.id,
                    role: role === 'viewer' ? ('viewer' as const) : ('collaborator' as const),
                  },
                  role,
                  joined: false,
                })
                setCollabNotice({
                  kind: 'external',
                  text: editing
                    ? '외부에서 변경된 내용이 공유 방에 있습니다 — 방 내용을 따라갑니다'
                    : '외부에서 변경된 내용이 있어 방 내용을 따라갑니다',
                })
                return
              }
            } catch {
              // 아래 폴백으로 떨어진다.
            }
          }
          if (dead) return
          // 복구 불가: 보기 전용으로 두고 "다시 연결" 버튼을 띄운다.
          setCollab(null)
          setForceViewOnly(true)
          setCollabNotice({
            kind: 'stale',
            text: editing
              ? '공유 상태가 낡았습니다 — 다시 연결하면 복구를 시도합니다'
              : '공유 상태가 낡아 실시간 보기를 시작할 수 없습니다',
          })
          return
        }
        const me = readCollabUser()
        // X1c(P1): joined=false 로 시작한다 — lib 이 방에 붙고 문서를 적용하면
        // onCollaborationChange(active) 에서 joined=true 로 열린다.
        setForceViewOnly(false)
        setCollab({
          roomId: info.roomId,
          baseHash: info.lastHash,
          epoch: info.epoch ?? '',
          serverUrl: collabServerUrl(),
          // X2a: 브라우저별 collab-user id를 lib에 넘긴다(presence userId → 서버 묶기 키).
          // viewer 는 role:'viewer' 로 참가한다(문서를 seed 하지 않는다).
          // C1: 편집자는 role:'collaborator' 를 명시한다(people 표시·lib 쓰기 판정의 근거).
          user: {
            name: me?.name?.trim() || 'user',
            color: me?.color || '#2563eb',
            id: me?.id,
            role: role === 'viewer' ? ('viewer' as const) : ('collaborator' as const),
          },
          role,
          joined: false,
        })
        setCollabNotice(null)
      } catch (e) {
        if (dead) return
        setCollab(null)
        // C2-b: 서버 자체에 닿지 못한 경우(응답 없음)에만 단독 편집을 허용한다(If-Match 잠금 유지).
        // 서버가 응답한 실패는 보기 전용으로 둔다.
        const axiosErr = e as { isAxiosError?: boolean; response?: unknown } | null
        const offline = !!axiosErr && axiosErr.isAxiosError === true && axiosErr.response == null
        if (offline) {
          setCollabNotice(
            editing
              ? {
                  kind: 'error',
                  text: '서버에 연결할 수 없습니다 — 오프라인으로 편집합니다. 연결되면 다시 연결하세요',
                }
              : {
                  kind: 'error',
                  text: '서버에 연결할 수 없습니다 — 파일만 보여줍니다',
                },
          )
          return
        }
        setForceViewOnly(true)
        setCollabNotice(
          editing
            ? {
                kind: 'error',
                text: `동시편집 연결에 실패했습니다 — 보기 전용으로 둡니다${
                  e instanceof Error ? ` (${e.message})` : ''
                }`,
              }
            : {
                kind: 'error',
                text: '실시간 보기 연결에 실패했습니다 — 파일만 보여줍니다',
              },
        )
      }
    })()
    return () => {
      dead = true
      if (joinAgainTimerRef.current) {
        clearTimeout(joinAgainTimerRef.current)
        joinAgainTimerRef.current = null
      }
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
    }
    // etagProp(바이트와 같은 응답의 ETag)이 바뀌면 재참가한다.
    // content 자체는 deps에 넣지 않는다(저장 후 raw 재수신으로 방에서 떨어지면 안 된다).
  }, [editing, path, joinKey, etagProp])
  const [comments, setComments] = useState<XlsxComment[]>([])
  const [showComments, setShowComments] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [author, setAuthor] = useState(() => {
    try {
      // 저장된 값이 없으면 collab-user 이름을 처음 한 번만 기본값으로 가져온다.
      // TODO(v0.13): 저장된 이름이 collab 이름 변경을 따라가지 않는다. 입력칸 초기값을
      // collab-user에서 항상 읽도록 정리한다.
      return localStorage.getItem('xlsx-comment-author') ?? readCollabUser()?.name ?? ''
    } catch {
      return ''
    }
  })
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [deleteArm, setDeleteArm] = useState<string | null>(null)
  useEffect(() => {
    setSavedBytes(null)
  }, [data])
  // 파일 op 한 번: 편집 중이면 뷰어 모델을 먼저 파일에 굳히고(편집을 날리지 않기 위해),
  // op 적용 → 저장 → 패널 새로고침 → 뷰어 리마운트 순서로 처리한다.
  const mutateXlsxComments = async (
    op: (base: Uint8Array) => Promise<Uint8Array>,
  ): Promise<boolean> => {
    // X1a 함정: 코멘트는 파일 바이트를 직접 고쳐 쓰는 방식이라, 방(위 협업 문서)과
    // 어긋난다(저장 후 뷰어를 다시 마운트하면 방의 내용이 이긴다 → 코멘트가 사라진다).
    // C3: 편집 잠금과 같은 조건(참가 중 2명 이상)에서만 막는다. 혼자면 허용한다.
    if (collabLockedRef.current) {
      showToast.info('동시편집 중에는 코멘트 저장을 할 수 없습니다')
      return false
    }
    try {
      let base = content
      if (editing) {
        if (!xlsxHandle?.save) return false
        const blob: Blob = await xlsxHandle.save()
        const cur = new Uint8Array(await blob.arrayBuffer())
        await saveOfficeBytes(path, fileName ?? 'workbook.xlsx', new Blob([cur as unknown as BlobPart]))
        base = cur
      }
      const next = await op(base)
      await saveOfficeBytes(path, fileName ?? 'workbook.xlsx', new Blob([next as unknown as BlobPart]))
      setSavedBytes(next)
      const cs = await loadXlsxComments(next)
      setComments(cs)
      setReloadKey((v) => v + 1)
      return true
    } catch (e) {
      showToast.error(e instanceof Error ? e.message : '코멘트 저장 실패')
      return false
    }
  };
  const addComment = async () => {
    const text = draft.trim()
    if (!text || adding) return
    let ref = ''
    try {
      ref = xlsxHandle?.getSelection?.() ?? ''
    } catch {
      ref = ''
    }
    if (!ref.trim()) {
      showToast.info('셀을 먼저 선택하세요')
      return
    }
    // 작성자 단일 통로: 입력값 → collab-user 이름. 가짜 기본값을 넣지 않는다.
    const name = author.trim() || readCollabUser()?.name?.trim() || ''
    if (!name) {
      showToast.error('작성자 이름을 입력하세요')
      return
    }
    setAdding(true)
    try {
      // 선택 문자열에 시트명이 있으면 해당 시트, 없으면 0번 시트.
      let sheetIndex = 0
      const m = ref.match(/^'((?:[^']|'')+)'!|^([^!]+)!/)
      const sheetName = (m?.[1] ?? m?.[2] ?? '').replace(/''/g, "'")
      if (sheetName) {
        const names = await loadXlsxSheetNames(content)
        const found = names.findIndex((n) => n === sheetName)
        if (found >= 0) sheetIndex = found
      }
      const ok = await mutateXlsxComments((base) =>
        addXlsxComment(base, { sheetIndex, ref, authorName: name, text }),
      )
      if (!ok) return
      setDraft('')
      try {
        localStorage.setItem('xlsx-comment-author', name)
      } catch {
        /* 무시 */
      }
      showToast.success('코멘트 저장했습니다')
    } finally {
      setAdding(false)
    }
  }
  const sendReply = async (c: XlsxComment) => {
    const text = replyDraft.trim()
    if (!text || busyId || !c.tid) return
    const name = author.trim() || readCollabUser()?.name?.trim() || ''
    if (!name) {
      showToast.error('작성자 이름을 입력하세요')
      return
    }
    setBusyId(`reply:${c.tid}`)
    try {
      const ok = await mutateXlsxComments((base) =>
        replyXlsxComment(base, { parentTid: c.tid, authorName: name, text }),
      )
      if (ok) {
        setReplyTo(null)
        setReplyDraft('')
        showToast.success('답글 저장했습니다')
      }
    } finally {
      setBusyId(null)
    }
  }
  const toggleResolve = async (c: XlsxComment) => {
    if (busyId || !c.tid) return
    setBusyId(`resolve:${c.tid}`)
    try {
      await mutateXlsxComments((base) => setXlsxCommentDone(base, { tid: c.tid, done: !c.resolved }))
    } finally {
      setBusyId(null)
    }
  }
  const saveEdit = async (c: { tid: string }) => {
    const text = editDraft.trim()
    if (!text || busyId) return
    setBusyId(`edit:${c.tid}`)
    try {
      await mutateXlsxComments((base) => editXlsxComment(base, { tid: c.tid, text }))
      setEditingId(null)
    } finally {
      setBusyId(null)
    }
  }
  const doDelete = async (c: { tid: string }) => {
    if (busyId || !c.tid) return
    if (deleteArm !== c.tid) {
      setDeleteArm(c.tid)
      return
    }
    setDeleteArm(null)
    setBusyId(`delete:${c.tid}`)
    try {
      await mutateXlsxComments((base) => deleteXlsxComment(base, c.tid))
    } finally {
      setBusyId(null)
    }
  }
  const xlsxRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // lib에서 바뀌면(편집·코멘트) 목록도 다시 읽는다 (저장 전에도 보인다).
  const refreshXlsxComments = useCallback(async () => {
    try {
      const bytes = xlsxHandle?.saveBytes
        ? await xlsxHandle.saveBytes('xlsx')
        : content
      const cs = await loadXlsxComments(bytes)
      setComments(cs)
    } catch {
      /* 무시 */
    }
  }, [content, xlsxHandle])
  const scheduleXlsxRefresh = useCallback(() => {
    if (xlsxRefreshTimer.current) clearTimeout(xlsxRefreshTimer.current)
    xlsxRefreshTimer.current = setTimeout(() => {
      void refreshXlsxComments()
    }, 1200)
  }, [refreshXlsxComments])
  useEffect(
    () => () => {
      if (xlsxRefreshTimer.current) clearTimeout(xlsxRefreshTimer.current)
    },
    [],
  )

  // 코멘트가 있으면 목록 패널을 같이 열어준다 (보기/편집 공통).
  useEffect(() => {
    let dead = false
    setComments([])
    setShowComments(false)
    void loadXlsxComments(content).then((cs) => {
      if (dead) return
      setComments(cs)
    })
    return () => {
      dead = true
    }
  }, [content])

  // collaboration 옵션은 **항상 같은 객체**를 넘긴다(매 렌더 새 객체면 lib 가 방을 다시 연다).
  // joined 변화는 옵션을 새로 만들면 안 된다 — 그래서 deps 에 joined 를 넣지 않는다.
  const collabOptions = useMemo(() => {
    if (!collab) return undefined
    return {
      roomId: collab.roomId,
      serverUrl: collab.serverUrl,
      user: collab.user,
      // C4: 개체 브로드캐스트(type 102) 수신용 탭 transport. lib가 모르는 타입은
      // 여기서 소비하고, 나머지는 그대로 lib에 넘긴다 (lib 패치 없음).
      // (재)연결 때마다 GET으로 놓친 브로드캐스트를 따라잡는다.
      provider: createObjectTapProvider(
        collab.serverUrl,
        collab.roomId,
        (msg) => objOnMessageRef.current?.(msg),
        () => objConnectRef.current?.(),
      ),
    }
    // joined 를 의존성에서 빼는 것은 방을 다시 열지 않기 위한 의도다.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- joined 를 넣으면 lib 가 방을 다시 연다(leave/join 순환 → 유실)
  }, [collab?.roomId, collab?.serverUrl, collab?.user])

  /**
   * X2a-③: viewer가 방 내용을 따라간다. collaboration-change 이벤트에서만 rooms() 를
   * 읽는다(새 폴링/interval 없음). 편집자가 처음 생기고 방에 문서가 올라왔으면
   * 에디터를 한 번 리마운트한다. 방이 아직 비었으면 1회만 다시 확인한다(단발 타이머).
   */
  const refreshViewerRoom = useCallback(async (): Promise<void> => {
    const roomId = collabRef.current?.roomId
    if (!roomId || editingRef.current) return
    let rooms: CollabRoomSummary[]
    try {
      rooms = await collabApi.rooms()
    } catch {
      return
    }
    if (editingRef.current) return
    const mine = rooms.find((r) => r.roomId === roomId)
    if (!mine) return
    const editors = mine.participants.filter((p) => p.mode === 'edit').length
    onRoomHasEditorsChangeRef.current?.(editors > 0)
    if (hadEditorsRef.current || editors === 0) return
    if (mine.seeded) {
      hadEditorsRef.current = true
      setViewerGen((g) => g + 1)
      return
    }
    if (!recheckTimer.current) {
      recheckTimer.current = setTimeout(() => {
        recheckTimer.current = null
        if (!editingRef.current) void refreshViewerRoom()
      }, 3000)
    }
  }, [])

  // X1b: 방을 아는 저장. `/api/collab/save` 로 통일한다.
  //  - 낙관적 잠금(base hash): 방 리스트가 알고 있으면 base 로 보내고 아니면 거부된다.
  //  - conflict_room(다른 참가자가 먼저 저장) 은 방 상태를 다시 직렬화해 1회 재시도.
  //  - conflict_external(외부 변경) 은 재시도 금지. 배너 + 내 사본 다운로드로 알린다.
  //  - X2a-③: lib 세션의 clientId 를 보낸다. viewer 면 서버가 403 view_only 로 거부한다.
  /**
   * C2-c: quiet=true면 성공 토스트를 띄우지 않는다(자동 저장용).
   * 실패 경로(토스트+배너+내 사본 다운로드)는 그대로 둔다.
   */
  const saveViaRoom = useCallback(async (quiet = false): Promise<boolean> => {
    const room = collabRef.current
    const handle = xlsxHandleRef.current
    if (!room || !handle?.saveBytes) return false
    try {
      let bytes = new Uint8Array(await handle.saveBytes())
      let res = await collabApi.save(room.roomId, selfClientIdRef.current ?? XLSX_SAVE_CLIENT_ID, bytes, room.baseHash)
      if (!res.ok && res.reason === 'conflict_room') {
        // 방 상태를 다시 직렬화해서 1회 재시도한다(모두 같은 방 상태를 갖고 있다).
        bytes = new Uint8Array(await handle.saveBytes())
        res = await collabApi.save(room.roomId, selfClientIdRef.current ?? XLSX_SAVE_CLIENT_ID, bytes, res.currentHash ?? room.baseHash)
      }
      if (!res.ok) {
        // X1c(P0-2): 모든 저장 실패에 내 사본 다운로드를 제공한다.
        await storeFailedBytes(null)
        if (res.reason === 'conflict_external') {
          setCollabNotice({
            kind: 'external',
            text: '파일이 동시편집 밖에서 변경되어 저장을 막았습니다 — 내 사본을 내려받아 확인하세요',
          })
          showToast.error('파일이 외부에서 변경되어 저장을 막았습니다')
          window.dispatchEvent(new CustomEvent('officeSaveDone', { detail: { ok: false, path, hasFailedCopy: true } }))
          return false
        }
        setCollabNotice({
          kind: 'error',
          text: `저장 실패 — 내 사본을 내려받아 확인하세요 (${res.message ?? res.reason})`,
        })
        showToast.error(res.message ?? '저장 실패')
        window.dispatchEvent(new CustomEvent('officeSaveDone', { detail: { ok: false, path, hasFailedCopy: true } }))
        return false
      }
      room.baseHash = res.newHash
      // X1c: 방 저장이 디스크를 바꿨으므로 단독 저장의 If-Match(ETag) 도 새 해시로 동기화한다.
      // 놓치면 뒤에 단독 저장이 낡은 ETag 로 나가 409 를 반복한다.
      setEtag(res.newHash)
      void queryClient.invalidateQueries({ queryKey: ['files'] })
      if (!quiet) showToast.success('저장했습니다')
      // X1b: keepEditing — Save 는 편집을 유지한다(Done 만 편집을 끝낸다).
      window.dispatchEvent(new CustomEvent('officeSaveDone', { detail: { ok: true, path, keepEditing: true } }))
      return true
    } catch (e) {
      // X1c(P0-2): 예외(네트워크·방 없음)도 내 사본 다운로드를 제공한다.
      await storeFailedBytes(e)
      setCollabNotice({
        kind: 'error',
        text: `저장 실패 — 내 사본을 내려받아 확인하세요 (${e instanceof Error ? e.message : 'unknown'})`,
      })
      showToast.error(e instanceof Error ? e.message : '저장 실패')
      window.dispatchEvent(new CustomEvent('officeSaveDone', { detail: { ok: false, path, hasFailedCopy: true } }))
      return false
    }
  }, [path, queryClient, storeFailedBytes])

  /**
   * C2-c: 편집이 멈추면 owner만 자동 저장한다.
   * - owner 판정은 방 참가자 목록(서버 선출)에서 읽는다. 이벤트 기반이라 별도 폴링 없음.
   * - owner를 모르면(조회 실패·미선출) baseHash 잠금에 맡기고 저장한다(멱등).
   * - viewer·미참가·탭 숨김 상태에서는 저장하지 않는다.
   */
  /**
   * C4: 시트 개체 표 동기화 (서버가 진실).
   * - 방에 붙으면 서버 개체 표를 받아 와(__ck 태그) 스냅샷 기준점을 잡는다.
   * - 로컬 workbook-change(원격 적용 제외)에서 anchor/삭제 diff를 서버에 보낸다.
   * - 서버 브로드캐스트(type 102)는 applyExternal로 적용한다(undo 기록 없음).
   */
  type ObjCore = {
    workbook?: { sheets?: Array<{ drawings?: Array<DrawingLike & { __ck?: string }> }> }
    session?: {
      applyExternal?: (apply: () => { kind?: string; label?: string; structural?: boolean; sheet?: number } | void) => unknown
    }
  }
  const objEditorCore = useCallback((): ObjCore | null => {
    try {
      const el = (xlsxHandleRef.current as unknown as { element?: unknown } | null)?.element as { core?: unknown } | undefined
      const core = el?.core as ObjCore | undefined
      return core && typeof core === 'object' ? core : null
    } catch {
      return null
    }
  }, [])
  const objAllKeyed = useCallback((): Array<{ key: string; sheet: number; index: number; d: DrawingLike & { __ck?: string } }> => {
    const out: Array<{ key: string; sheet: number; index: number; d: DrawingLike & { __ck?: string } }> = []
    try {
      const sheets = objEditorCore()?.workbook?.sheets ?? []
      sheets.forEach((s, si) => {
        if (Array.isArray(s?.drawings)) {
          s.drawings.forEach((d, i) => {
            const dd = d as DrawingLike & { __ck?: string }
            if (dd && typeof dd.__ck === 'string') out.push({ key: dd.__ck, sheet: si, index: i, d: dd })
          })
        }
      })
    } catch {
      /* 무시 */
    }
    return out
  }, [objEditorCore])
  const objKindItems = useCallback((): Array<{ sheet: number; kind: string }> => {
    const out: Array<{ sheet: number; kind: string }> = []
    try {
      const sheets = objEditorCore()?.workbook?.sheets ?? []
      sheets.forEach((s, si) => {
        if (Array.isArray(s?.drawings)) {
          for (const d of s.drawings) out.push({ sheet: si, kind: describeDrawingKind(d as DrawingLike) })
        }
      })
    } catch {
      /* 무시 */
    }
    return out
  }, [objEditorCore])
  /** surgical oleObj(EMB)가 있으면 전체 개체 op를 막는다 (혼자 편집 포함). */
  const objHasEmb = useCallback((): boolean => {
    try {
      const sheets = objEditorCore()?.workbook?.sheets ?? []
      return sheets.some(
        (s) => Array.isArray(s?.drawings) && (s.drawings as DrawingLike[]).some((d) => hasEmbObject([d as { sourceXml?: string }])),
      )
    } catch {
      return false
    }
  }, [objEditorCore])
  const objToast = useCallback(
    (text: string): void => {
      // C4-3: 같은 문구는 2초 안에 한 번만 (pointerdown 요청 토스트와 가드 토스트가
      // 같은 409 사유로 겹칠 때 1회로 합친다).
      const now = Date.now()
      const last = objToastLastRef.current
      if (last.text === text && now - last.at < 2000) return
      objToastLastRef.current = { text, at: now }
      try {
        showToast.warning(text)
      } catch {
        /* 무시 */
      }
    },
    [],
  )
  const objHolderName = useCallback(
    (clientId: number): string => {
      const p = xlsxPeopleRef.current.find((x) => x.clientId === clientId)
      return p?.name || '상대방'
    },
    [],
  )
  /** C4-3: 원격 선택 오버레이 다시 그리기 트리거 (락 표 변경 시 bump). */
  const [objRemoteRev, setObjRemoteRev] = useState(0)
  const touchObjRemote = useCallback((): void => {
    setObjRemoteRev((v) => v + 1)
  }, [])
  /**
   * C4-3: 내가 잡은 락을 푼다 (DELETE /objects/:room/:key/lock).
   * 테이블에 lockId가 없으면 GET으로 확인한다. 남의 락은 절대 건드리지 않는다.
   * 조용히 실패한다 (TTL 10초 + WS 끊김 시 서버 해제가 안전망).
   */
  const objReleaseLock = useCallback(
    async (key: string): Promise<boolean> => {
      try {
        const room = collabRef.current
        const me = selfClientIdRef.current
        if (!room || me == null) return false
        let lock = objTableRef.current.get(key)?.lock ?? null
        if (!lock) {
          try {
            const st = await collabApi.objects.get(room.roomId)
            for (const o of st.objects) {
              objTableRef.current.set(o.key, {
                sheet: o.sheet,
                kind: o.kind,
                anchor: o.anchor,
                deleted: o.deleted,
                version: o.version,
                lock: o.lock,
              })
            }
            lock = st.objects.find((o) => o.key === key)?.lock ?? null
          } catch {
            return false
          }
        }
        if (!lock || lock.clientId !== me) return false
        try {
          await collabApi.objects.unlock(room.roomId, key, lock.lockId)
        } catch {
          return false
        }
        const entry = objTableRef.current.get(key)
        if (entry && entry.lock?.lockId === lock.lockId) {
          objTableRef.current.set(key, { ...entry, lock: null })
          touchObjRemote()
        }
        return true
      } catch {
        return false
      }
    },
    [touchObjRemote],
  )
  /** C4-3: 내가 잡은 모든 락을 푼다 (Done·언마운트 시 best-effort). */
  const objReleaseAllMine = useCallback(async (): Promise<void> => {
    try {
      const me = selfClientIdRef.current
      if (me == null) return
      const mine: string[] = []
      for (const [k, e] of objTableRef.current) {
        if (e.lock && e.lock.clientId === me && !e.deleted) mine.push(k)
      }
      await Promise.all(mine.map((k) => objReleaseLock(k).catch(() => false as const)))
    } catch {
      /* best-effort */
    }
  }, [objReleaseLock])
  const objSnapshotAll = useCallback((): void => {
    objLastSentRef.current.clear()
    for (const { key, d } of objAllKeyed()) {
      objLastSentRef.current.set(key, { anchor: anchorKey(d.anchor), deleted: false })
    }
  }, [objAllKeyed])
  const objApplyServerState = useCallback(async (roomId: string): Promise<void> => {
    try {
      const st = await collabApi.objects.get(roomId)
      applyingRemoteRef.current = true
      try {
        for (const o of st.objects) {
          const prev = objTableRef.current.get(o.key)
          objTableRef.current.set(o.key, {
            sheet: o.sheet,
            kind: o.kind,
            anchor: o.anchor,
            deleted: o.deleted,
            version: o.version,
            lock: o.lock,
          })
          if (!prev) continue
        }
        touchObjRemote()
        objVersionRef.current = st.version
        const core = objEditorCore()
        const session = core?.session
        const wb = core?.workbook
        if (!wb || !session?.applyExternal) {
          objSnapshotAll()
          return
        }
        let changed = false
        const apply = (): { kind: string; label: string } | void => {
          for (const o of st.objects) {
            const sheets = wb.sheets ?? []
            let target: { anchor: unknown } | null = null
            for (const s of sheets) {
              if (target || !Array.isArray(s?.drawings)) continue
              const found = (s.drawings as Array<DrawingLike & { __ck?: string }>).find(
                (d) => d && (d as { __ck?: string }).__ck === o.key,
              ) as (DrawingLike & { anchor?: unknown }) | undefined
              if (found) target = found as { anchor: unknown }
            }
            if (!target && !o.deleted) continue
            if (o.deleted) {
              if (target) {
                for (const s of sheets) {
                  if (!Array.isArray(s?.drawings)) continue
                  const i = (s.drawings as Array<unknown>).indexOf(target as unknown)
                  if (i >= 0) {
                    ;(s.drawings as Array<unknown>).splice(i, 1)
                    changed = true
                    break
                  }
                }
              }
              continue
            }
            // C4: 서버 anchor가 null이면 "아직 모름"(등록 직후)이라 적용할 정보가
            // 없다. 로컬 실측을 null로 덮으면 이후 diff·이동이 깨지므로 건너뛴다.
            if (o.anchor == null) continue
            if (target && anchorKey((target as { anchor?: unknown }).anchor) !== anchorKey(o.anchor)) {
              ;(target as { anchor?: unknown }).anchor = JSON.parse(JSON.stringify(o.anchor ?? null)) as unknown
              changed = true
            }
          }
          if (!changed) return undefined
          return { kind: 'remote-draw', label: 'Remote object change' }
        }
        session.applyExternal(apply)
        objSnapshotAll()
      } finally {
        applyingRemoteRef.current = false
      }
    } catch {
      /* 조용히 실패 (다음 변경·수신 때 따라잡는다) */
    }
    }, [objEditorCore, objSnapshotAll, touchObjRemote])
  /** C4: 서버 순서를 로컬 drawings에 붙인다 (__ck 태그). 어긋나면 false. */
  const objTagWithOrder = useCallback(
    (order: Record<string, string[]> | null, objects: Array<{ key: string; sheet: number; kind: string; deleted: boolean }>): boolean => {
      if (!order) return false
      try {
        const sheets = objEditorCore()?.workbook?.sheets ?? []
        const flat: Array<{ sheet: number; kind: string; index: number }> = []
        sheets.forEach((s, si) => {
          if (!Array.isArray(s?.drawings)) return
          ;(s.drawings as Array<DrawingLike>).forEach((d, i) => {
            flat.push({ sheet: si, kind: describeDrawingKind(d), index: i })
          })
        })
        const byKey = new Map(objects.map((o) => [o.key, { sheet: o.sheet, kind: o.kind, deleted: o.deleted }] as const))
        const m = assignObjectKeys(order, byKey, flat)
        if (!m) return false
        for (const [li, key] of m) {
          const f = flat[li]
          if (!f) continue
          const d = (sheets[f.sheet]?.drawings as Array<DrawingLike & { __ck?: string }> | undefined)?.[f.index]
          if (d && typeof d === 'object') d.__ck = key
        }
        return true
      } catch {
        return false
      }
    },
    [objEditorCore],
  )
  const objRegister = useCallback(async (): Promise<boolean> => {
    const room = collabRef.current
    const hash = room?.baseHash
    const roomId = room?.roomId
    if (!room || !hash || !roomId || !editingRef.current) return false
    // C4: 같은 키로 완료된 등록은 건너뛴다 (재연결·dep 변화 때 중복 방지).
    // epoch이 바뀌면(방 재생성) 새 방이므로 다시 등록한다.
    const regKey = `${path}|${roomId}|${room.epoch}|${hash}|v${viewerGen}`
    if (objRegisteredRef.current === regKey) return true
    try {
      const st = await collabApi.objects.get(roomId)
      objVersionRef.current = st.version
      for (const o of st.objects) {
        objTableRef.current.set(o.key, { sheet: o.sheet, kind: o.kind, anchor: o.anchor, deleted: o.deleted, version: o.version, lock: o.lock })
      }
      const items = objKindItems()
      // C4: 모델이 아직 안 올라왔으면 키를 소비하지 말고 다음 기회에
      // (join 직후 마운트 레이스에서 영구 미등록이 되던 구멍).
      if (items.length === 0) return false
      if (st.order) {
        // 대조: 같은 해시 순서와 로컬이 같은지 (시트·종류별 개수, 삭제분 제외).
        if (!objTagWithOrder(st.order, st.objects)) {
          objMismatchRef.current = true
          try {
            console.warn('[c4] objects order mismatch; object ops locked for this session')
          } catch {
            /* 무시 */
          }
        } else {
          objSnapshotAll()
        }
        objRegisteredRef.current = regKey
        // C4: 태그 직후 서버 표를 모델에 적용한다. 입장 시 브로드캐스트가
        // 태그보다 먼저 도착하면 적용이 스킵되어 영원히 구모델에 머무른다.
        await objApplyServerState(roomId)
        return true
      }
      const r = await collabApi.objects.register(roomId, hash, items)
      if (!r.ok) {
        if (r.code === 'order_mismatch') {
          objMismatchRef.current = true
          try {
            console.warn('[c4] objects register mismatch; object ops locked for this session')
          } catch {
            /* 무시 */
          }
          objRegisteredRef.current = regKey
          return true
        }
        return false
      }
      if (r.objects) {
        for (const o of r.objects) {
          objTableRef.current.set(o.key, { sheet: o.sheet, kind: o.kind, anchor: o.anchor, deleted: o.deleted, version: o.version, lock: o.lock })
        }
      }
      if (typeof r.version === 'number') objVersionRef.current = r.version
      if (r.order && r.objects) {
        if (!objTagWithOrder(r.order, r.objects)) {
          objMismatchRef.current = true
        }
        objSnapshotAll()
      }
      objRegisteredRef.current = regKey
      await objApplyServerState(roomId)
      return true
    } catch {
      /* 조용히 실패 (다음 기회에 재시도) */
      return false
    }
  }, [objApplyServerState, objSnapshotAll, objKindItems, objTagWithOrder, path, viewerGen])
  const objChainRef = useRef(Promise.resolve())
  /**
   * C4: 서버에 거부된 로컬 변경을 기준점(lastSent)으로 되돌린다.
   * - 이동 거부: 모델 anchor를 lastSent로 덮어쓴다 (서버 anchor가 null이면
   *   따라잡기가 스킵되어 유령 상태가 남으므로, 되돌리기가 없으면 안 된다).
   * - 삭제 거부: 지워진 그림은 anchor로 복원할 수 없어 undo로 되살린다.
   *   undo 스택 꼭대기가 삭제가 아니면(그 사이 사용자 편집) 건드리지 않는다.
   *   되돌리기 undo는 가드 우회 플래그로 허용한다 (사용자 경로 아님).
   */
  const objRevertKeyToLastSent = useCallback(
    (key: string): void => {
      try {
        const prev = objLastSentRef.current.get(key)
        if (!prev || prev.deleted) return
        const core = objEditorCore()
        const session = core?.session as
          | {
              applyExternal?: (apply: () => { kind?: string; label?: string } | void) => unknown
              undo?: () => unknown
              undoLabel?: () => string | undefined
            }
          | undefined
        const wb = core?.workbook
        if (!wb || !session) return
        let modelHas = false
        try {
          const sheets = wb.sheets ?? []
          outer: for (const s of sheets) {
            if (!Array.isArray(s?.drawings)) continue
            for (const d of s.drawings as Array<{ __ck?: unknown }>) {
              if (d && typeof d === 'object' && (d as { __ck?: unknown }).__ck === key) {
                modelHas = true
                break outer
              }
            }
          }
        } catch {
          return
        }
        applyingRemoteRef.current = true
        try {
          if (modelHas) {
            let want: unknown = null
            try {
              want = JSON.parse(prev.anchor) as unknown
            } catch {
              return
            }
            if (want == null) return
            let changed = false
            const apply = (): { kind: string; label: string } | void => {
              const sheets = wb.sheets ?? []
              for (const s of sheets) {
                if (!Array.isArray(s?.drawings)) continue
                for (const d of s.drawings as Array<{ __ck?: unknown; anchor?: unknown }>) {
                  if (!d || typeof d !== 'object' || (d as { __ck?: unknown }).__ck !== key) continue
                  if (anchorKey((d as { anchor?: unknown }).anchor) !== anchorKey(want)) {
                    ;(d as { anchor?: unknown }).anchor = JSON.parse(JSON.stringify(want)) as unknown
                    changed = true
                  }
                }
              }
              if (!changed) return undefined
              return { kind: 'remote-draw', label: 'Remote object change' }
            }
            session.applyExternal?.(apply)
          } else {
            // 삭제 거부: 스택 꼭대기가 삭제일 때만 undo로 되살린다.
            let label: string | undefined
            try {
              label = session.undoLabel?.()
            } catch {
              label = undefined
            }
            if (label !== 'Delete object') return
            objUndoRevertRef.current = true
            try {
              session.undo?.()
            } finally {
              objUndoRevertRef.current = false
            }
          }
        } finally {
          applyingRemoteRef.current = false
        }
      } catch {
        /* 되돌리기 실패는 조용히 무시 (다음 따라잡기가 수습한다) */
      }
    },
    [objEditorCore],
  )
  /** C4: 한 개체의 최신 상태를 서버와 맞춘다 (체인 안에서 호출, 실행 시점 재확인). */
  const objFlushKey = useCallback(
    async (roomId: string, clientId: number, key: string): Promise<void> => {
      if (applyingRemoteRef.current || objMismatchRef.current) return
      try {
        // 최신 상태 다시 읽기.
        let found: { anchor: unknown } | null = null
        let foundDeleted = true
        try {
          const sheets = objEditorCore()?.workbook?.sheets ?? []
          outer: for (const s of sheets) {
            if (!Array.isArray(s?.drawings)) continue
            for (const d of s.drawings as Array<DrawingLike & { __ck?: string }>) {
              if (d && typeof d === 'object' && (d as { __ck?: unknown }).__ck === key) {
                found = { anchor: (d as { anchor?: unknown }).anchor }
                foundDeleted = false
                break outer
              }
            }
          }
        } catch {
          return
        }
        const prev = objLastSentRef.current.get(key)
        const anchorStr = found && !foundDeleted ? anchorKey(found.anchor) : ''
        const changed = !prev || prev.deleted !== foundDeleted || (!foundDeleted && prev.anchor !== anchorStr)
        if (!changed) return
        const r =
          found && !foundDeleted
            ? await collabApi.objects.move(roomId, key, clientId, found.anchor, objVersionRef.current)
            : await collabApi.objects.del(roomId, key, clientId, objVersionRef.current)
        if (!r.ok) {
          // 거부된 로컬 변경을 기준점으로 되돌린 뒤 서버 표를 따라잡는다.
          // 서버 anchor가 null이면 따라잡기가 스킵되므로 되돌리기가 필수다.
          objRevertKeyToLastSent(key)
          await objApplyServerState(roomId)
          if (r.code === 'locked' || r.code === 'not_holder') {
            const h = typeof (r as { holder?: unknown }).holder === 'number' ? (r as { holder: number }).holder : null
            objToast(`${h != null ? objHolderName(h) : '상대방'}가 편집 중입니다`)
          } else if (r.code === 'version_mismatch' || r.code === 'emb_locked' || r.code === 'deleted') {
            objToast('동시편집 중에는 이 편집을 지원하지 않습니다')
          }
          return
        }
        if (typeof r.version === 'number') objVersionRef.current = r.version
        if (found && !foundDeleted) {
          objLastSentRef.current.set(key, { anchor: anchorStr, deleted: false })
        } else {
          objLastSentRef.current.set(key, { anchor: '', deleted: true })
          // C4-3: 삭제 완료 → 내 락 해제 (서버는 삭제해도 락을 유지하므로 명시 해제).
          if (objActiveKeyRef.current === key) objActiveKeyRef.current = null
          void objReleaseLock(key)
        }
      } catch {
        /* 네트워크 실패: 다음 change에서 재시도 */
      }
    },
    [objEditorCore, objApplyServerState, objHolderName, objToast, objRevertKeyToLastSent, objReleaseLock],
  )
  const objSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** C4: 바뀐 개체를 모아 체인에 건다. 실행 시점에 최신 상태를 다시 읽는다. */
  const objFlushChanged = useCallback(
    (roomId: string, clientId: number): void => {
      const keys = new Set<string>()
      let untagged = 0
      try {
        const sheets = objEditorCore()?.workbook?.sheets ?? []
        sheets.forEach((s) => {
          if (!Array.isArray(s?.drawings)) return
          const ds = s.drawings as Array<DrawingLike & { __ck?: string }>
          for (const d of ds) {
            if (d && typeof d === 'object' && typeof (d as { __ck?: unknown }).__ck !== 'string') untagged += 1
          }
          for (const c of diffObjects(
            ds,
            objLastSentRef.current,
            (i) => {
              const k = ds[i]?.__ck
              return typeof k === 'string' ? k : null
            },
            keys,
          )) {
            if (c.type === 'move') keys.add(c.key)
          }
        })
      } catch {
        return
      }
      // C4: 태그 없는 그림이 있으면 리마운트 직후(새 모델)일 수 있다.
      // 이때 lastSent 기준으로 삭제를 단정하면 전체 오삭제 POST 폭주이므로,
      // 재등록·재태그될 때까지 삭제 판정만 보류한다 (이동은 태그 기반으로 보낸다).
      if (untagged === 0) {
        for (const [key, prev] of objLastSentRef.current) {
          if (!prev.deleted && !keys.has(key)) keys.add(key)
        }
      }
      if (keys.size === 0) return
      for (const key of keys) {
        objChainRef.current = objChainRef.current
          .then(async () => {
            await objFlushKey(roomId, clientId, key)
          })
          .catch(() => {
            /* 무시 */
          })
      }
    },
    [objEditorCore, objFlushKey],
  )
  const objSendSweep = useCallback((): void => {
    // C4: trailing debounce — Yjs 직접 반영과 서버 브로드캐스트가 뒤섞여
    // 도착해도 조용해진 뒤 한 번만 판단한다 (메아리 방지).
    if (!editingRef.current || applyingRemoteRef.current || objMismatchRef.current) return
    if (!collabRef.current || selfClientIdRef.current == null) return
    if (objSendTimerRef.current) clearTimeout(objSendTimerRef.current)
    objSendTimerRef.current = setTimeout(() => {
      objSendTimerRef.current = null
      const room = collabRef.current
      const clientId = selfClientIdRef.current
      if (!room || clientId == null || !editingRef.current || applyingRemoteRef.current || objMismatchRef.current) return
      void objFlushChanged(room.roomId, clientId)
    }, 500)
  }, [objFlushChanged])
  /**
   * C3: lib 편집 가드를 등록/해제한다. 편집기 마운트 상태와 무관하게,
   * 방 참가 + 2명 이상일 때만 켠다. 언마운트·나가기·혼자 남으면 끈다.
   * C4: 개체 op(Move/Delete)는 개체 표 + 락으로 판정한다(서버가 최종 판정).
   * solo + EMB(surgical oleObj)가 있으면 혼자라도 가드를 건다.
   */
  useEffect(() => {
    const g = globalThis as unknown as Record<string, unknown>
    // C4: solo + EMB(surgical oleObj)면 혼자라도 가드를 건다 (이동·삭제 전부 잠금).
    let embLocked = false
    try {
      if (collab?.joined && xlsxHandle) embLocked = objHasEmb()
    } catch {
      embLocked = false
    }
    if (collab?.joined && (xlsxPeople.length >= 2 || embLocked)) {
      g.__ooxmlEditGuard = (label: string, kind: string): boolean => {
        // C4: 서버 거부 후 되돌리기용 undo/redo는 항상 허용한다 (사용자 경로 아님).
        if (objUndoRevertRef.current && (kind === 'undo' || kind === 'redo') && (label === 'Move object' || label === 'Delete object')) return true
        let browserOnline = true
        try {
          // setOffline 같은 브라우저 단절은 즉시 반영된다 (lib 상태보다 빠르다).
          browserOnline = window.navigator.onLine !== false
        } catch {
          browserOnline = true
        }
        let ctx: ObjectGuardCtx = NO_OBJECT_GUARD
        if (label === 'Move object' || label === 'Delete object') {
          const foreign = new Set<string>()
          const me = selfClientIdRef.current
          for (const [k, v] of objTableRef.current) {
            if (v.lock && v.lock.clientId !== me) foreign.add(k)
          }
          ctx = { embLocked, mismatch: objMismatchRef.current, activeKey: objActiveKeyRef.current, foreignKeys: foreign, online: connOnlineRef.current && browserOnline }
        }
        if (!isBlockedXlsxEdit(kind, label, ctx)) return true
        // C4-3: 남이 잡은 개체면 홀더 이름 토스트 (드래그 1회에 1번; objToast가 문구별 2초 dedupe).
        // 그 외 차단(오프라인·mismatch·EMB·버전 등)은 일반 잠금 토스트.
        if (decideObjectOp(kind, label, ctx) === 'foreign' && objActiveKeyRef.current) {
          const entry = objTableRef.current.get(objActiveKeyRef.current)
          const holder = entry?.lock && entry.lock.clientId !== selfClientIdRef.current ? entry.lock.clientId : null
          objToast(`${holder != null ? objHolderName(holder) : '상대방'}가 편집 중입니다`)
        } else {
          objToast('동시편집 중에는 이 편집을 지원하지 않습니다')
        }
        return false
      }
    } else {
      delete g.__ooxmlEditGuard
    }
    return () => {
      delete (globalThis as unknown as Record<string, unknown>).__ooxmlEditGuard
    }
    // joined/인원/핸들/EMB 판정 변화 때 재평가한다.
  }, [collab?.joined, xlsxPeople, xlsxHandle, objHasEmb, objHolderName, objToast])

  /** C4: 개체 변경 수신기 (서버 브로드캐스트 type 102). */
  const objOnMessage = useCallback(
    (msg: ObjectsStateMsg) => {
      if (!editingRef.current) return
      // C4: 에러형(유령) 브로드캐스트면 표를 건드리지 않고 GET으로 따라잡는다.
      if (!Array.isArray(msg.objects)) {
        const roomId = collabRef.current?.roomId
        if (roomId) void objApplyServerState(roomId)
        return
      }
      void (async () => {
        try {
          for (const o of msg.objects ?? []) {
            objTableRef.current.set(o.key, {
              sheet: o.sheet,
              kind: o.kind,
              anchor: o.anchor,
              deleted: o.deleted,
              version: o.version,
              lock: o.lock,
            })
          }
          touchObjRemote()
          if (typeof msg.version === 'number') objVersionRef.current = msg.version
          const core = objEditorCore()
          const session = core?.session
          const wb = core?.workbook
          if (!wb || !session?.applyExternal) return
          applyingRemoteRef.current = true
          try {
            let changed = false
            const apply = (): { kind: string; label: string } | void => {
              for (const o of msg.objects ?? []) {
                const sheets = wb.sheets ?? []
                let target: { anchor?: unknown } | null = null
                let targetSheet = -1
                let targetIndex = -1
                for (let si = 0; si < sheets.length && !target; si++) {
                  const s = sheets[si]
                  if (!Array.isArray(s?.drawings)) continue
                  const i = (s.drawings as Array<{ __ck?: string }>).findIndex((d) => d && (d as { __ck?: string }).__ck === o.key)
                  if (i >= 0) {
                    target = (s.drawings as Array<{ anchor?: unknown }>)[i] as { anchor?: unknown }
                    targetSheet = si
                    targetIndex = i
                  }
                }
                if (o.deleted) {
                  if (target && targetSheet >= 0) {
                    const ds = sheets[targetSheet]?.drawings as unknown[] | undefined
                    if (Array.isArray(ds)) ds.splice(targetIndex, 1)
                    changed = true
                  }
                  continue
                }
                // C4: 서버 anchor가 null이면 "아직 모름"(등록 직후)이라 적용할 정보가
                // 없다. 로컬 실측을 null로 덮으면 이후 diff·이동이 깨지므로 건너뛴다.
                if (o.anchor == null) continue
                if (target && anchorKey((target as { anchor?: unknown }).anchor) !== anchorKey(o.anchor)) {
                  ;(target as { anchor?: unknown }).anchor = JSON.parse(JSON.stringify(o.anchor ?? null)) as unknown
                  changed = true
                }
              }
              if (!changed) return undefined
              return { kind: 'remote-draw', label: 'Remote object change' }
            }
            session.applyExternal(apply)
            objSnapshotAll()
          } finally {
            applyingRemoteRef.current = false
          }
        } catch {
          /* 무시 */
        }
      })()
    },
    [objApplyServerState, objEditorCore, objSnapshotAll, touchObjRemote],
  )
  objOnMessageRef.current = objOnMessage
  /** C4-3: 남이 잡은 개체 오버레이 (테두리+이름표) 목록. 배치 좌표는 아래 레이어 기준 px. */
  const [objRemoteSels, setObjRemoteSels] = useState<Array<{ id: string; key: string; name: string; color: string; left: number; top: number; width: number; height: number }>>([])
  const objOverlayLayerRef = useRef<HTMLDivElement | null>(null)
  const objLayoutRafRef = useRef(0)
  /**
   * C4-3: 서버 표의 남 잠금을 DOM 위치로 바꾼다.
   * - 키→모델 drawings __ck→data-index→.xg-obj 노드 순으로 찾는다.
   * - 보이는 노드마다 오버레이를 둔다 (고정 행/열 quadrants 중복 대응).
   * - 스크롤·줌·원격 이동은 호출 측(이벤트·옵저버·따라잡기)이 다시 부른다. 폴링 없음.
   */
  const layoutObjOverlays = useCallback((): void => {
    try {
      const layer = objOverlayLayerRef.current
      if (!layer) return
      const layerBox = layer.getBoundingClientRect()
      if (layerBox.width <= 0 || layerBox.height <= 0) {
        setObjRemoteSels((prev) => (prev.length === 0 ? prev : []))
        return
      }
      let host: Element | null = null
      try {
        const h = xlsxHandleRef.current as unknown as { element?: unknown } | null
        const cand = h?.element
        host = cand instanceof Element ? cand : document.querySelector('xlsx-editor')
      } catch {
        host = null
      }
      if (!host) return
      const root: Element | ShadowRoot = (host as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot ?? host
      const me = selfClientIdRef.current
      const activeSheet = objActiveSheetRef.current
      const indexByKey = new Map<string, number>()
      try {
        const drawings = objEditorCore()?.workbook?.sheets?.[activeSheet]?.drawings
        if (Array.isArray(drawings)) {
          drawings.forEach((d, i) => {
            const k = (d as { __ck?: unknown } | null)?.__ck
            if (d && typeof k === 'string') indexByKey.set(k, i)
          })
        }
      } catch {
        /* 무시 */
      }
      const out: Array<{ id: string; key: string; name: string; color: string; left: number; top: number; width: number; height: number }> = []
      const seen = new Set<string>()
      for (const [key, entry] of objTableRef.current) {
        if (!entry.lock || entry.lock.clientId === me || entry.deleted) continue
        if (entry.sheet !== activeSheet) continue
        if (seen.has(key)) continue
        const idx = indexByKey.get(key)
        if (idx == null) continue
        const nodes = root.querySelectorAll(`.xg-obj[data-index="${idx}"]`)
        const person = xlsxPeopleRef.current.find((x) => x.clientId === entry.lock!.clientId)
        const name = person?.name || '상대방'
        const color = person?.color || '#9aa0a6'
        for (const n of Array.from(nodes)) {
          const r = (n as HTMLElement).getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          seen.add(key)
          out.push({
            id: `${key}#${idx}`,
            key,
            name,
            color,
            left: Math.round(r.left - layerBox.left),
            top: Math.round(r.top - layerBox.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          })
          break
        }
      }
      setObjRemoteSels((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out))
    } catch {
      /* 무시 */
    }
  }, [objEditorCore])
  /** C4-3: 오버레이 재배치 요청 (rAF 1회로 합친다). */
  const scheduleObjLayout = useCallback((): void => {
    try {
      if (objLayoutRafRef.current) return
      objLayoutRafRef.current = requestAnimationFrame(() => {
        objLayoutRafRef.current = 0
        layoutObjOverlays()
      })
    } catch {
      /* 무시 */
    }
  }, [layoutObjOverlays])
  // C4-3: 락 표 변경·리마운트 때마다 오버레이를 다시 배치한다.
  useEffect(() => {
    layoutObjOverlays()
  }, [layoutObjOverlays, objRemoteRev, xlsxHandle, viewerGen, editing])
  // C4-3: 스크롤·줌·리사이즈·lib 리페인트 때는 옵저버로 따라간다 (폴링 없음).
  useEffect(() => {
    let host: Element | null = null
    try {
      const h = xlsxHandleRef.current as unknown as { element?: unknown } | null
      const cand = h?.element
      host = cand instanceof Element ? cand : document.querySelector('xlsx-editor')
    } catch {
      host = null
    }
    if (!host) return
    const onScroll = (): void => {
      scheduleObjLayout()
    }
    window.addEventListener('scroll', onScroll, true)
    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(() => scheduleObjLayout())
      const layer = objOverlayLayerRef.current
      if (layer) ro.observe(layer)
      ro.observe(host)
    } catch {
      ro = null
    }
    let mo: MutationObserver | null = null
    try {
      const root: Element | ShadowRoot = (host as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot ?? host
      mo = new MutationObserver(() => scheduleObjLayout())
      mo.observe(root as unknown as Node, { childList: true, subtree: true, attributes: true })
    } catch {
      mo = null
    }
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      try {
        ro?.disconnect()
      } catch {
        /* 무시 */
      }
      try {
        mo?.disconnect()
      } catch {
        /* 무시 */
      }
      try {
        if (objLayoutRafRef.current) cancelAnimationFrame(objLayoutRafRef.current)
      } catch {
        /* 무시 */
      }
      objLayoutRafRef.current = 0
    }
  }, [xlsxHandle, scheduleObjLayout])
  // C4: 탭 transport (재)연결 때마다 GET으로 따라잡는다. 초기 연결 때는
  // 등록 효과와 순서가 뒤바뀌어도 안전하다 (미태그 상태면 표만 채우고 끝난다).
  // (재)연결은 마운트보다 늦어 모델이 올라와 있을 확률이 높아 등록 재시도
  // 기회로도 쓴다 (미로딩이면 키를 소비하지 않아 다음에 다시 한다).
  objConnectRef.current = () => {
    if (!editingRef.current || !collabRef.current?.joined) return
    const room = collabRef.current
    if (!room?.roomId) return
    void objRegister().finally(() => {
      if (!editingRef.current || collabRef.current?.roomId !== room.roomId) return
      void objApplyServerState(room.roomId)
    })
  }

  const objRegisteredRef = useRef('')
  /** C4: 마지막으로 등록·태그한 에디터 핸들. 리마운트(새 모델·태그 소실)하면 다시 등록한다. */
  const objHandleRef = useRef<unknown>(null)
  useEffect(() => {
    if (!editing || !collab?.joined || !xlsxHandle) return
    if (objHandleRef.current !== xlsxHandle) {
      objHandleRef.current = xlsxHandle
      objRegisteredRef.current = ''
    }
    void objRegister().finally(() => {
      touchObjRemote()
    })
    // xlsxPeople.length: 마운트 직후 모델 미로딩으로 등록이 미뤄졌을 때
    // presence 도착이 재시도 기회가 된다 (키 미소비 + 이 dep).
    // collab?.epoch: 방 재생성(orphan dispose) 후에는 표가 비어서 다시 등록한다.
  }, [editing, collab?.joined, collab?.roomId, collab?.epoch, collab?.baseHash, xlsxHandle, path, etag, viewerGen, objRegister, xlsxPeople.length, touchObjRemote])

  /** C4: pointerdown 대상에서 개체 키를 찾는다 (shadow DOM 안 .xg-obj[data-index]). */
  const objKeyFromTarget = useCallback((t: unknown): string | null => {
    try {
      const node = (t as { closest?: (sel: string) => Element | null } | null)?.closest?.('.xg-obj') as
        | HTMLElement
        | null
        | undefined
      if (!node) return null
      const idx = Number((node as unknown as { dataset?: { index?: string } }).dataset?.index)
      if (!Number.isInteger(idx)) return null
      const ds = objEditorCore()?.workbook?.sheets?.[objActiveSheetRef.current]?.drawings
      if (!Array.isArray(ds)) return null
      const d = ds[idx] as (DrawingLike & { __ck?: string }) | undefined
      return d && typeof d.__ck === 'string' ? d.__ck : null
    } catch {
      return null
    }
  }, [objEditorCore])
  /** C4: 개체 락 요청 (fire-and-forget, 409면 토스트). 성공 시 내 셀 잔상을 지운다. */
  const objRequestLock = useCallback(
    (key: string): void => {
      try {
        const entry = objTableRef.current.get(key)
        const me = selfClientIdRef.current
        if (entry?.lock && entry.lock.clientId !== me) {
          objToast(`${objHolderName(entry.lock.clientId)}가 편집 중입니다`)
          return
        }
        const room = collabRef.current
        if (!room || me == null) return
        void collabApi.objects
          .lock(room.roomId, key, me)
          .then((r) => {
            if (!r.ok) {
              if (r.code === 'locked') {
                const h = typeof (r as { holder?: unknown }).holder === 'number' ? (r as { holder: number }).holder : null
                objToast(`${h != null ? objHolderName(h) : '상대방'}가 편집 중입니다`)
              }
              return
            }
            // C4-3: 잡는 데 성공하면 상대 화면에서 내 셀 박스가 사라진다.
            // (다음 셀 선택 변경 때 lib이 다시 게시한다.)
            try {
              xlsxHandleRef.current?.updateCollabIdentity?.({ sheet: null, range: null })
            } catch {
              /* 무시 */
            }
          })
          .catch(() => {
            /* 무시 */
          })
      } catch {
        /* 무시 */
      }
    },
    [objHolderName, objToast],
  )

  /** C4: sheet-change 추적 + 개체 pointerdown (shadow DOM 안이라 네이티브 캡처) + 셀 선택 변경 추적. */
  useEffect(() => {
    let el: Element | null = null
    try {
      const h = xlsxHandleRef.current as unknown as { element?: unknown } | null
      const cand = h?.element
      el = cand instanceof Element ? cand : document.querySelector('xlsx-editor')
    } catch {
      el = null
    }
    if (!el) return
    const onSheet = (ev: Event): void => {
      const idx = (ev as CustomEvent<{ index?: unknown }>).detail?.index
      if (typeof idx === 'number') {
        objActiveSheetRef.current = idx
        touchObjRemote()
      }
    }
    el.addEventListener('sheet-change', onSheet as EventListener)
    const root: Element | ShadowRoot = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot ?? el
    const onDown = (ev: Event): void => {
      if (!editingRef.current || !collabRef.current?.joined) return
      const key = objKeyFromTarget((ev as { target?: unknown }).target)
      if (!key) return
      // C4-3: 다른 개체를 잡으면 이전 락을 먼저 푼다.
      const prev = objActiveKeyRef.current
      if (prev && prev !== key) {
        objActiveKeyRef.current = null
        void objReleaseLock(prev)
      }
      objActiveKeyRef.current = key
      // C4-3: 클릭 에코 판정용 — lib getSelection()은 selection-change detail.ref와 같은 함수다.
      try {
        const g = xlsxHandleRef.current?.getSelection?.()
        objGrabSelRef.current = typeof g === 'string' && g ? { sheet: objActiveSheetRef.current, ref: g } : null
      } catch {
        objGrabSelRef.current = null
      }
      objRequestLock(key)
    }
    // C4-3: 셀을 클릭하면(선택 변경) 내 개체 선택을 해제하고 락도 푼다.
    // lib은 개체 클릭에도 클릭 전과 같은 선택으로 selection-change 에코를 쏘므로
    // detail이 pointerdown 당시 스냅샷과 같으면 에코로 보고 무시한다.
    // 되돌리기 undo·팔로우 이동 중에는 건드리지 않는다.
    const onSelChange = (ev: Event): void => {
      try {
        if (objUndoRevertRef.current) return
        if (followNavigatingRef.current) return
        if (!editingRef.current || !collabRef.current?.joined) return
        const key = objActiveKeyRef.current
        if (!key) return
        const grab = objGrabSelRef.current
        const d = (ev as CustomEvent<{ sheet?: unknown; ref?: unknown }>).detail
        if (grab && d && d.sheet === grab.sheet && d.ref === grab.ref) return
        objGrabSelRef.current = null
        objActiveKeyRef.current = null
        void objReleaseLock(key)
      } catch {
        /* 무시 */
      }
    }
    el.addEventListener('selection-change', onSelChange as EventListener)
    root.addEventListener('pointerdown', onDown as EventListener, true)
    // C4-3: Escape는 개체 선택 해제 + 락 해제 (팝오버는 각자 닫는다).
    const onKey = (ev: Event): void => {
      try {
        if ((ev as KeyboardEvent).key !== 'Escape') return
        if (!editingRef.current || !collabRef.current?.joined) return
        const key = objActiveKeyRef.current
        if (!key) return
        objActiveKeyRef.current = null
        void objReleaseLock(key)
      } catch {
        /* 무시 */
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      try {
        el?.removeEventListener('sheet-change', onSheet as EventListener)
      } catch {
        /* 무시 */
      }
      try {
        el?.removeEventListener('selection-change', onSelChange as EventListener)
      } catch {
        /* 무시 */
      }
      try {
        root.removeEventListener('pointerdown', onDown as EventListener, true)
      } catch {
        /* 무시 */
      }
      window.removeEventListener('keydown', onKey, true)
    }
  }, [xlsxHandle, editing, objKeyFromTarget, objRequestLock, objReleaseLock, touchObjRemote])

  /**
   * C4-3: 편집이 끝나면(Done·파일 전환·언마운트) 내가 잡은 락을 푼다 (best-effort).
   * 서버도 WS 끊김·TTL로 정리하지만, 명시 해제가 가장 빠르다.
   */
  useEffect(() => {
    if (editing) return
    void objReleaseAllMine()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])
  useEffect(() => {
    return () => {
      void objReleaseAllMine()
    }
    // objReleaseAllMine은 안정적이라 실질적으로 언마운트 때만 돈다.
  }, [objReleaseAllMine])

  /**
   * C3: 1→2 참가 시 owner면 즉시 저장한다 (디바운스 건너뜀).
   * 혼자 편집하다 상대가 들어오면, 예약된 자동 저장을 기다리지 않고 방 상태를 확정한다.
   * 뒤늦게 들어온 참가자는 stale_client 재수신으로 최신 바이트를 받는다.
   */
  const prevPeopleCountRef = useRef(0)
  useEffect(() => {
    const prev = prevPeopleCountRef.current
    prevPeopleCountRef.current = xlsxPeople.length
    if (!(prev <= 1 && xlsxPeople.length >= 2)) return
    if (!collab?.joined || collab.role !== 'edit' || !editingRef.current) return
    if (!autosavePendingRef.current || autosaveInFlightRef.current) return
    void (async () => {
      try {
        const rooms = await collabApi.rooms()
        const me = collabRef.current ? rooms.find((r) => r.roomId === collabRef.current!.roomId)?.participants.find((x) => x.id === collabRef.current!.user.id) : undefined
        if (!shouldFlushOnPeerArrive({ hasPendingAutosave: true, isOwner: me?.owner, joined: true })) return
        if (autosaveTimerRef.current) {
          clearTimeout(autosaveTimerRef.current)
          autosaveTimerRef.current = null
        }
        autosavePendingRef.current = false
        autosaveInFlightRef.current = true
        try {
          await saveViaRoom(true)
        } finally {
          autosaveInFlightRef.current = false
        }
      } catch {
        /* 실패하면 예약된 자동 저장이 처리한다 */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xlsxPeople, collab?.joined])

  const scheduleAutosave = useCallback(() => {
    if (!editingRef.current) return
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    autosavePendingRef.current = true
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null
      autosavePendingRef.current = false
      void (async () => {
        try {
          if (document.hidden) return
          const c = collabRef.current
          if (!c || !c.joined || c.role !== 'edit' || !editingRef.current) return
          if (autosaveInFlightRef.current) return
          let skip = false
          try {
            const rooms = await collabApi.rooms()
            const mine = rooms.find((r) => r.roomId === c.roomId)?.participants.find((x) => x.id === c.user.id)
            if (mine) skip = mine.owner !== true
            else skip = (rooms.find((r) => r.roomId === c.roomId)?.participants.some((x) => x.owner === true)) === true
          } catch {
            // 조회 실패는 잠금에 맡긴다.
          }
          if (skip) return
          autosaveInFlightRef.current = true
          try {
            await saveViaRoom(true)
          } finally {
            autosaveInFlightRef.current = false
          }
        } catch {
          // 다음 편집 때 다시 예약된다.
        }
      })()
    }, AUTOSAVE_DEBOUNCE_MS)
  }, [saveViaRoom])
  // 방에 붙었으면 방 경로, 단독이면 단독 경로(/api/files)로 저장한다.
  const save = useCallback(async (): Promise<boolean> => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    autosavePendingRef.current = false
    const room = collabRef.current
    // X2a-③: viewer 는 self clientId 를 알아야 저장할 수 있다. 아직 모르면 막는다
    // (clientId 없이 저장하면 서버가 못 막는다).
    if (room?.role === 'viewer' && selfClientIdRef.current == null) {
      showToast.error('실시간 보기에 연결 중입니다 — 잠시 뒤 다시 저장하세요')
      return false
    }
    if (room) return saveViaRoom()
    return saveSoloBase()
  }, [saveViaRoom, saveSoloBase])

  // 뷰어 툴바 저장 가로채기 (기본 다운로드를 막고 제자리 저장) + 상단 저장 버튼.
  useEffect(() => {
    const el = listenRef.current
    if (!el) return
    const onFileCommand = (e: Event) => {
      const cmd = (e as CustomEvent<{ command?: string }>).detail?.command
      if (cmd === 'save') {
        e.preventDefault()
        void save()
      }
    }
    el.addEventListener('file-command', onFileCommand)
    return () => el.removeEventListener('file-command', onFileCommand)
  }, [save, editing])
  // B1(b): officeSaveRequest는 window 전역이다. 편집이 아닐 때 듣으면 편집 진입 전이나
  // 보기 화면에서 떠오른 저장이 XLSX 편집 세션과 엮인다.
  // X2a-③: viewer 로 참가 중에도 듣는다(403 view_only 확인용). 방에 붙지 않았으면 무시한다.
  useEffect(() => {
    const onSave = () => {
      if (!editing && collabRef.current?.role !== 'viewer') return
      void save()
    }
    window.addEventListener('officeSaveRequest', onSave)
    return () => window.removeEventListener('officeSaveRequest', onSave)
  }, [save, editing])
  // 상단 코멘트 버튼: 우측 목록 패널을 여닫는다.
  useEffect(() => {
    const onToggle = () => {
      setShowComments((v) => !v)
    }
    window.addEventListener('xlsxCommentsToggle', onToggle)
    return () => window.removeEventListener('xlsxCommentsToggle', onToggle)
  }, [])

  const openComment = (c: XlsxComment) => {
    try {
      xlsxHandle?.setActiveSheet?.(c.sheetIndex)
    } catch {
      /* 무시 */
    }
    setTimeout(() => {
      try {
        xlsxHandle?.select?.(c.ref)
      } catch {
        /* 무시 */
      }
    }, 80)
  }

  if (error) return <ErrorNote msg={error} />
  return (
    <EngineHost className="xlsxengine-host h-full min-h-[480px]">
      <div ref={listenRef} className="flex h-full min-h-0">
        <div className="flex-1 min-w-0 h-full">
          <Suspense fallback={SPINNER}>
          {connecting && (
            // X1c(P1): 방 참가 판정이 끝날 때까지 입력을 막는다(연결 배너).
            // 편집기 자체는 열어야 방 참가(lib)가 시작된다.
            <div
              data-testid="xlsx-collab-connecting"
              className="absolute left-2 right-2 bottom-2 z-20 flex items-center gap-2 rounded-md border border-border bg-background/90 px-3 py-2 text-xs text-muted-foreground shadow-sm"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              동시편집 연결 중 — 판정이 끝나면 편집이 열립니다
            </div>
          )}
          {collab && xlsxPeople.length > 0 && (
            // C3: 공용 presence 바 (PPT와 같은 마크업·testid).
            <CollabPresenceShell>
              <CollabPresenceBar
                peers={groupXlsxPeopleForView(xlsxPeople)}
                followId={xlsxFollowId}
                onFollowToggle={(id) => setXlsxFollowId((prev) => (prev === id ? null : id))}
                onRename={(name) => {
                  try {
                    xlsxHandleRef.current?.updateCollabIdentity?.({ name })
                  } catch {
                    /* 무시 */
                  }
                }}
                // C3: 바깥 클릭은 시트 직접 조작 의사로 보고 따라가기를 푼다 (P-7b).
                onDismiss={() => setXlsxFollowId(null)}
              />
            </CollabPresenceShell>
          )}
          {/* C4-3 원격 개체 오버레이의 기준 박스 (absolute inset-0). */}
          <div
            onPointerDown={(e) => { if (!followNavigatingRef.current && !isFollowUiTarget(e.target)) setXlsxFollowId(null) }}
            onWheel={(e) => { if (!followNavigatingRef.current && !isFollowUiTarget(e.target)) setXlsxFollowId(null) }}
            onKeyDown={(e) => { if (!followNavigatingRef.current && !isFollowUiTarget(e.target)) setXlsxFollowId(null) }}
            // X2a-③ 후속: 연결 판정이 끝날 때까지 에디터를 숨긴다(display:none).
            // lib readOnly 는 DOM 입력을 막지 못해 programmatic fill 이 통과하고,
            // fill 과 방 적용이 레이스하면 조용히 유실된다. display:none 조상 아래에서는
            // 자손 CSS 가 visibility 를 덮어써도 bounding box 가 비어 fill 이 확정
            // 실패하므로(typed=false) 판정 뒤 1회 재입력 경로로 수렴한다.
            // lib 동기화는 WS/모델 계층이라 표시 여부와 무관하다.
            style={connecting ? { display: 'none' } : undefined}
            className="relative h-full"
            data-testid={connecting ? 'xlsx-editor-hidden' : undefined}
          >
          <SpreadsheetEditor
            // X1b: 편집 종료(Done)로는 편집기를 내린다 → lib 이 소유한 방 세션도 끝나고
            // 소켓이 내려간다(X-M6). 저장은 편집을 유지하므로 키가 바뀌지 않는다.
            // X2a-③: viewer 세대는 방 내용을 따라가기 위한 리마운트에 쓴다.
            key={`xlsx-${reloadKey}-${editing ? 'edit' : 'view'}-v${viewerGen}`}
            ref={setXlsxHandle}
            bytes={content}
            fileName={fileName}
            // X1c(P1): 방 판정이 끝날 때까지 편집을 막는다(먼저 입력한 내용의 유실 방지).
            readOnly={!editing || connecting || forceViewOnly}
            showToolbar={editing}
            showFormulaBar={editing}
            theme={appTheme}
            collaboration={collabOptions}
            onCollaborationChange={(state) => {
              // X1c(P1): 방에 실제로 붙었을 때(연결 + 첫 교환 완료)만 잠금을 푼다.
              // X1d: `active` 는 공유가 시작됐다는 뜻일 뿐 소켓이 열렸다는 뜻이 아니다
              // (routeWebSocket 차단 테스트 X0a-10 에서 조기 해제 발견). status 가
              // 'connected' 이고 `synced`(첫 교환 완료)일 때만 푼다.
              if (state.active && state.status === 'connected' && state.synced)
                setCollab((prev) => (prev ? { ...prev, joined: true } : prev))
              // C4: 소켓 상태를 기억한다. 끊기면 개체 op를 막는다(서버 강제 불가).
              connOnlineRef.current = state.status === 'connected'
              // X2a-③: 저장에 쓸 lib clientId 를 기억한다(viewer 403 확인용).
              const self = state.people.find((p) => p.self)
              if (self) selfClientIdRef.current = self.clientId
              // C1: presence 바 표시용. 바뀌었을 때만 갱신한다(heartbeat 재게시 리렌더 방지).
              setXlsxPeople((prev) => {
                const next = (state.people ?? []) as XlsxPresencePerson[]
                if (sameXlsxPeople(prev, next)) return prev
                return next
              })
                // C1: 따라가던 상대가 나가면 팔로우를 해제한다 (묶음 기준: 같은 userId 탭이 하나라도 남으면 유지).
                setXlsxFollowId((prev) => {
                  if (prev == null) return prev
                  const still = ((state.people ?? []) as XlsxPresencePerson[]).some((p) => {
                    if (p.self) return false
                    const k = typeof p.userId === 'string' && p.userId ? `u:${p.userId}` : `c:${p.clientId}`
                    return k === prev
                  })
                  return still ? prev : null
                })
              // X2a-③: viewer 는 방 참가자 변화를 따라간다(리마운트·코멘트 게이트).
              if (!editingRef.current) void refreshViewerRoom()
            }}
            onWorkbookError={(e) => setError(e instanceof Error ? e.message : String(e))}
          onWorkbookChange={() => {
            scheduleXlsxRefresh()
            if (editingRef.current) scheduleAutosave()
            objSendSweep()
          }}
          />
          {/* C4-3: 남이 잡은 개체 표시 (테두리+이름표). lib 원격 셀 박스와 같은 스타일.
              pointer-events:none 이라 편집을 막지 않는다. */}
          <div
            ref={objOverlayLayerRef}
            data-testid="xlsx-object-remote-layer"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
          >
              {objRemoteSels.map((o) => (
                <div
                  key={o.id}
                  data-testid="xlsx-object-remote-sel"
                  data-key={o.key}
                title={o.name}
                style={{
                  position: 'absolute',
                  left: o.left,
                  top: o.top,
                  width: o.width,
                  height: o.height,
                  border: `2px solid ${o.color}`,
                  borderRadius: 2,
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: -2,
                    top: -19,
                    height: 16,
                    lineHeight: '16px',
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '0 4px',
                    color: '#fff',
                    backgroundColor: o.color,
                    borderRadius: '2px 2px 2px 0',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 160,
                  }}
                >
                  {o.name}
                </span>
              </div>
            ))}
          </div>
          </div>
          {!editing && collabNotice && (
            // X2a-③: 보기 모드 참가 판정 안내(방에 못 붙으면 파일만 보여준다).
            <div
              data-testid="xlsx-viewer-notice"
              className="absolute bottom-2 left-2 right-2 z-20 flex items-center gap-3 rounded-md border border-border bg-background/90 px-3 py-2 text-xs text-muted-foreground shadow-sm"
            >
              <span className="flex-1">{collabNotice.text}</span>
              {[('noetag' as const), ('stale' as const), ('timeout' as const), ('error' as const)].includes(
                collabNotice.kind as 'noetag' | 'stale' | 'timeout' | 'error',
              ) && (
                <button
                  type="button"
                  data-testid="xlsx-reconnect"
                  onClick={() => reconnectCollab()}
                  className="h-6 shrink-0 rounded border border-border px-2 font-medium hover:bg-muted"
                >
                  다시 연결
                </button>
              )}
            </div>
          )}
          {editing && collabNotice && (
            <div
              data-testid="xlsx-collab-banner"
              className="absolute bottom-2 left-2 right-2 z-20 flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground shadow-sm"
            >
              <span className="flex-1">{collabNotice.text}</span>
              {[('noetag' as const), ('stale' as const), ('timeout' as const), ('error' as const)].includes(
                collabNotice.kind as 'noetag' | 'stale' | 'timeout' | 'error',
              ) && (
                <button
                  type="button"
                  data-testid="xlsx-reconnect"
                  onClick={() => reconnectCollab()}
                  className="h-6 shrink-0 rounded border border-border px-2 font-medium hover:bg-muted"
                >
                  다시 연결
                </button>
              )}
              {conflictBytes && (
                <button
                  type="button"
                  data-testid="xlsx-collab-download"
                  onClick={() => {
                    const blob = new Blob([conflictBytes as unknown as BlobPart], {
                      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = fileName ?? 'workbook.xlsx'
                    a.click()
                    setTimeout(() => URL.revokeObjectURL(url), 1000)
                  }}
                  className="h-6 shrink-0 rounded border border-border px-2 font-medium hover:bg-muted"
                >
                  내 사본 다운로드
                </button>
              )}
            </div>
          )}
          </Suspense>
        </div>
        {showComments && (
          <div data-xlsx-comments className="w-72 shrink-0 border-l border-border bg-background flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-border text-xs font-medium flex-shrink-0 flex items-center gap-1">
              <span className="flex-1">코멘트 ({comments.length})</span>
              <button
                type="button"
                onClick={() => void refreshXlsxComments()}
                className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                title="다시 읽기"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
            <div className="p-2 border-b border-border flex-shrink-0 space-y-1.5">
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="이름"
                className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
              />
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="코멘트 입력 (선택한 셀)"
                rows={2}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
              />
              <Button
                size="sm"
                className="w-full h-7 text-xs"
                disabled={!draft.trim() || adding}
                onClick={() => void addComment()}
              >
                {adding ? '저장 중…' : '코멘트 저장'}
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
              {comments.length === 0 && (
                <p className="text-xs text-muted-foreground px-1">코멘트 없음</p>
              )}
              {comments.map((c, i) => (
                <div
                  key={`${c.tid || c.ref || i}`}
                  className="rounded-md border border-border/60 p-2"
                >
                  <button
                    type="button"
                    onClick={() => openComment(c)}
                    className="w-full text-left"
                    title={`${c.sheet}!${c.ref}로 이동`}
                  >
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="truncate">{c.sheet}</span>
                      <span className="shrink-0 font-mono">{c.ref}</span>
                      {c.resolved && <span className="shrink-0">· 해결됨</span>}
                    </div>
                    <div className="text-xs font-medium mt-0.5">{c.author}</div>
                    {editingId === (c.tid || `legacy:${i}`) ? (
                      <span className="block mt-0.5" onClick={(e) => e.stopPropagation()}>
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={2}
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
                        />
                      </span>
                    ) : (
                      <div className="text-xs whitespace-pre-wrap break-words mt-0.5">{c.text}</div>
                    )}
                  </button>
                  {c.replies.map((r, j) => (
                    <div key={j} className="mt-1.5 pl-2 border-l-2 border-border">
                      <div className="text-xs font-medium">{r.author}</div>
                      {editingId === r.tid ? (
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={2}
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none mt-0.5"
                        />
                      ) : (
                        <div className="text-xs whitespace-pre-wrap break-words">{r.text}</div>
                      )}
                      {r.tid && (
                        <div className="flex items-center gap-0.5 mt-1">
                          <XlsxIconBtn
                            title="수정"
                            onClick={() => {
                              setEditingId(r.tid)
                              setEditDraft(r.text)
                              setReplyTo(null)
                              setDeleteArm(null)
                            }}
                          >
                            <Pencil className="w-3 h-3" />
                          </XlsxIconBtn>
                          <XlsxIconBtn
                            title={deleteArm === r.tid ? '확인: 삭제' : '삭제'}
                            danger={deleteArm === r.tid}
                            onClick={() => void doDelete({ tid: r.tid })}
                          >
                            {deleteArm === r.tid ? <Check className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                          </XlsxIconBtn>
                          {editingId === r.tid && (
                            <>
                              <XlsxIconBtn title="저장" onClick={() => void saveEdit({ tid: r.tid })}>
                                <Check className="w-3 h-3" />
                              </XlsxIconBtn>
                              <XlsxIconBtn title="취소" onClick={() => setEditingId(null)}>
                                <X className="w-3 h-3" />
                              </XlsxIconBtn>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {replyTo === c.tid && c.tid && (
                    <div className="mt-1.5 space-y-1" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        value={replyDraft}
                        onChange={(e) => setReplyDraft(e.target.value)}
                        placeholder="답글 입력"
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
                      />
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          className="h-6 text-[11px] flex-1"
                          disabled={!replyDraft.trim() || !!busyId}
                          onClick={() => void sendReply(c)}
                        >
                          답글 저장
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px]"
                          onClick={() => {
                            setReplyTo(null)
                            setReplyDraft('')
                          }}
                        >
                          취소
                        </Button>
                      </div>
                    </div>
                  )}
                  {editingId === (c.tid || `legacy:${i}`) && c.tid && (
                    <div className="flex items-center gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        className="h-6 text-[11px] flex-1"
                        disabled={!editDraft.trim() || !!busyId}
                        onClick={() => void saveEdit(c)}
                      >
                        저장
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => setEditingId(null)}
                      >
                        취소
                      </Button>
                    </div>
                  )}
                  {c.tid && (
                    <div className="flex items-center gap-0.5 mt-1.5">
                      <XlsxIconBtn
                        title="답글"
                        onClick={() => {
                          setReplyTo(replyTo === c.tid ? null : c.tid)
                          setReplyDraft('')
                          setEditingId(null)
                          setDeleteArm(null)
                        }}
                      >
                        <Reply className="w-3 h-3" />
                      </XlsxIconBtn>
                      <XlsxIconBtn
                        title="수정"
                        onClick={() => {
                          setEditingId(c.tid)
                          setEditDraft(c.text)
                          setReplyTo(null)
                          setDeleteArm(null)
                        }}
                      >
                        <Pencil className="w-3 h-3" />
                      </XlsxIconBtn>
                      <XlsxIconBtn
                        title={c.resolved ? '미해결로' : '해결됨으로'}
                        onClick={() => void toggleResolve(c)}
                      >
                        {c.resolved ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                      </XlsxIconBtn>
                      <XlsxIconBtn
                        title={deleteArm === c.tid ? '확인: 삭제' : '삭제'}
                        danger={deleteArm === c.tid}
                        onClick={() => void doDelete(c)}
                      >
                        {deleteArm === c.tid ? <Check className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                      </XlsxIconBtn>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </EngineHost>
  )
}
