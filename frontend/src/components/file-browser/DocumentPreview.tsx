import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, Suspense } from 'react'
import { Loader2, AlertCircle, ZoomIn, ZoomOut, User, Users, Clock, Paperclip, File, RefreshCw, Reply, Pencil, Check, RotateCcw, Trash2, X } from 'lucide-react'
import { ViewerLoadBoundary } from './ViewerBoundaries'
import { SpreadsheetEditor } from '@christophervr/xlsx-react-viewer'
import PptxViewer from './PptxViewer'
import { WordEditor } from 'docx-react-viewer'
import { VisioViewer } from 'visio-react-viewer'
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
import { detectDocKind, type DocKind } from './docKind'
import { useTheme } from '@/hooks/useTheme'
import { readCollabUser } from '@/lib/collabUser'

type ExtractedMsg = {
  html?: string
  attachments?: Array<{ name: string; size: number; cid: string; mime: string }>
}

const CONVERTABLE_CLIENT_KINDS = new Set<DocKind>(['pdf', 'docx', 'xlsx', 'pptx'])

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

function useRawFile(path: string, enabled = true) {
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [error, setError] = useState('')

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
    }
  }, [path, enabled])

  return { data, status, error }
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

export function DocumentPreview({ file, refreshKey = 0 }: { file: FileInfo; refreshKey?: number }) {
  const kind = detectDocKind(file.name)
  // office 문서(docx/xlsx/pptx)는 바로 보기 우선 — PDF 변환 없이 바로 본다.
  // PDF가 필요하면 토글로 서버 변환을 켠다.
  const isOfficeNative = kind === 'docx' || kind === 'xlsx' || kind === 'pptx'
  const isViewerOnly = kind === 'visio'
  const [pdfMode, setPdfMode] = useState(false)
  const [editing, setEditing] = useState(false)
  const [viewerRetry, setViewerRetry] = useState(0)
  const [endingEdit, setEndingEdit] = useState(false)
  useEffect(() => { setPdfMode(false); setEditing(false) }, [file.path])
  const retryViewer = () => {
    // 정적 import라 청크 교체는 불필요 — 키만 바꿔 리마운트한다.
    setViewerRetry((v) => v + 1)
  }
  useEffect(() => {
    const onFs = (e: Event) => {
      if (!(e as CustomEvent<{ isFullscreen?: boolean }>).detail?.isFullscreen) setEditing(false)
    }
    window.addEventListener('fileFullscreenChange', onFs)
    return () => window.removeEventListener('fileFullscreenChange', onFs)
  }, [])
  // 저장 성공하면 편집을 끝내고 전체화면에서 복귀한다 (채팅 자리로).
  useEffect(() => {
    const onDone = (e: Event) => {
      if (!(e as CustomEvent<{ ok?: boolean }>).detail?.ok) return
      setEditing(false)
      window.dispatchEvent(new CustomEvent('fileFullscreenRequest', { detail: { isFullscreen: false } }))
    }
    window.addEventListener('officeSaveDone', onDone as EventListener)
    return () => window.removeEventListener('officeSaveDone', onDone as EventListener)
  }, [])
  // P1-6: 편집 종료는 flush가 끝날 때까지 기다린다. 실패하면 편집 유지(유실 방지).
  const requestOfficeSave = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        window.removeEventListener('officeSaveDone', onDone)
        resolve(false)
      }, 10000)
      const onDone = (e: Event) => {
        if (done) return
        done = true
        clearTimeout(timer)
        window.removeEventListener('officeSaveDone', onDone as EventListener)
        resolve(!!(e as CustomEvent<{ ok?: boolean }>).detail?.ok)
      }
      window.addEventListener('officeSaveDone', onDone as EventListener)
      window.dispatchEvent(new CustomEvent('officeSaveRequest'))
    })
  }, [])
  const endEditing = useCallback(async (after?: () => void) => {
    if (!editing || endingEdit) {
      after?.()
      return
    }
    setEndingEdit(true)
    try {
      const ok = await requestOfficeSave()
      if (ok) {
        setEditing(false)
        window.dispatchEvent(new CustomEvent('fileFullscreenRequest', { detail: { isFullscreen: false } }))
        after?.()
      } else {
        showToast.error('Save failed — staying in edit mode')
      }
    } finally {
      setEndingEdit(false)
    }
  }, [editing, endingEdit, requestOfficeSave])
  const converted = useConvertedPdf(file.path, refreshKey, kind !== 'msg' && kind !== 'visio' && (!isOfficeNative || pdfMode))
  const extracted = useExtractedText(file.path, refreshKey, kind === 'msg')

  const hasClientFallback = kind ? CONVERTABLE_CLIENT_KINDS.has(kind) : false
  const { data: raw, status: rawStatus, error: rawError } = useRawFile(
    file.path,
    isOfficeNative ? !pdfMode : isViewerOnly || (hasClientFallback && converted.status !== 'ready'),
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
            <XlsxViewer data={raw} fileName={file.name} editing={editing} path={file.path} />
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
          <PptxViewer key={file.path} data={raw} fileName={file.name} editing={editing} savePath={file.path} onFail={() => setPdfMode(true)} />
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
      {isOfficeNative && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-background flex-shrink-0">
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
                  className="h-6 text-xs px-2 rounded text-muted-foreground hover:text-foreground"
                  title="Show comments"
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
    setBusyId(`reply:${c.cid}`)
    try {
      const name = commentAuthorName()
      if (!name) {
        showToast.error('작성자 이름을 입력하세요')
        return
      }
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
  useEffect(() => {
    const onSave = () => {
      void save()
    }
    window.addEventListener('officeSaveRequest', onSave)
    return () => window.removeEventListener('officeSaveRequest', onSave)
  }, [save])

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

function XlsxViewer({ data, fileName, editing = false, path }: { data: ArrayBuffer; fileName?: string; editing?: boolean; path: string }) {
  const appTheme = useTheme()
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
  } | null>(null)
  const listenRef = useRef<HTMLDivElement>(null)
  const { save } = useOfficeSave(path, fileName ?? 'workbook.xlsx', xlsxHandle)
  const [comments, setComments] = useState<XlsxComment[]>([])
  const [showComments, setShowComments] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [author, setAuthor] = useState(() => {
    try {
      // 저장된 값이 없으면 collab-user 이름을 처음 한 번만 기본값으로 가져온다.
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
    setAdding(true)
    try {
      // 작성자 단일 통로: 입력값 → collab-user 이름. 가짜 기본값을 넣지 않는다.
      const name = author.trim() || readCollabUser()?.name?.trim() || ''
      if (!name) {
        showToast.error('작성자 이름을 입력하세요')
        return
      }
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
    setBusyId(`reply:${c.tid}`)
    try {
      const name = author.trim() || readCollabUser()?.name?.trim() || ''
      if (!name) {
        showToast.error('작성자 이름을 입력하세요')
        return
      }
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
  useEffect(() => {
    const onSave = () => {
      void save()
    }
    window.addEventListener('officeSaveRequest', onSave)
    return () => window.removeEventListener('officeSaveRequest', onSave)
  }, [save])
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
          <SpreadsheetEditor
            key={editing ? `edit-${reloadKey}` : `view-${reloadKey}`}
            ref={setXlsxHandle}
            bytes={content}
            fileName={fileName}
            readOnly={!editing}
            showToolbar={editing}
            showFormulaBar={editing}
            theme={appTheme}
            onWorkbookError={(e) => setError(e instanceof Error ? e.message : String(e))}
            onWorkbookChange={() => scheduleXlsxRefresh()}
          />
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
