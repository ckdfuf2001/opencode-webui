import { useEffect, useMemo, useRef, useState, type ReactNode, Suspense, lazy } from 'react'
import { Loader2, AlertCircle, ZoomIn, ZoomOut, User, Users, Clock, Paperclip, File } from 'lucide-react'

const SpreadsheetEditor = lazy(() =>
  import('@christophervr/xlsx-react-viewer').then((m) => ({ default: m.SpreadsheetEditor })),
)

const PptxViewer = lazy(() => import('./PptxViewer'))

const WordEditor = lazy(() =>
  import('docx-react-viewer').then((m) => ({ default: m.WordEditor })),
)

const VisioViewer = lazy(() =>
  import('visio-react-viewer').then((m) => ({ default: m.VisioViewer })),
)
import type { FileInfo } from '@/types/files'
import { API_BASE_URL } from '@/config'
import { Button } from '@/components/ui/button'

type DocKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'doc' | 'xls' | 'ppt' | 'msg' | 'visio'

type ExtractedMsg = {
  html?: string
  attachments?: Array<{ name: string; size: number; cid: string; mime: string }>
}

export function detectDocKind(name: string): DocKind | null {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx' || ext === 'docm' || ext === 'dotm') return 'docx'
  if (ext === 'doc') return 'doc'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'xltx' || ext === 'xltm') return 'xlsx'
  if (ext === 'xlsb') return 'xls'
  if (ext === 'pptx' || ext === 'pptm' || ext === 'ppsx' || ext === 'potx') return 'pptx'
  if (ext === 'ppt') return 'ppt'
  if (ext === 'msg') return 'msg'
  if (ext === 'vsdx' || ext === 'vsd') return 'visio'
  return null
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
    fetch(`${API_BASE_URL}/api/files/${path}?raw=true`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        if (!cancelled) {
          setData(buf)
          setStatus('ready')
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load file')
          setStatus('error')
        }
      })
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
  useEffect(() => { setPdfMode(false) }, [file.path])
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
      if (kind === 'pdf') return <PdfViewer data={raw} fileName={file.name} />
      if (kind === 'docx') return <DocxViewer data={raw} fileName={file.name} />
      if (kind === 'xlsx') return <XlsxViewer data={raw} fileName={file.name} />
      if (kind === 'visio') return <OfficeVisioViewer data={raw} fileName={file.name} />
      return <PptxViewer key={file.path} data={raw} fileName={file.name} onFail={() => setPdfMode(true)} />
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
              onClick={() => setPdfMode(false)}
              className={`h-6 text-xs px-2 rounded ${!pdfMode ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              title="변환 없이 바로 보기"
            >
              바로 보기
            </button>
            <button
              type="button"
              onClick={() => setPdfMode(true)}
              className={`h-6 text-xs px-2 rounded ${pdfMode ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              title="서버에서 Office로 PDF 변환해서 보기"
            >
              Office(PDF)
            </button>
          </div>
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

function DocxViewer({ data }: { data: ArrayBuffer; fileName?: string }) {
  const [model, setModel] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { createDocument, loadDocument } = await import('docx-react-viewer')
        if (cancelled) return
        setModel(createDocument())
        const loaded = await loadDocument(new Uint8Array(data.slice(0)))
        if (!cancelled) setModel(loaded.model)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to parse document')
      }
    })()
    return () => {
      cancelled = true
      setModel(null)
      setError(null)
    }
  }, [data])

  if (error) return <ErrorNote msg={error} />
  if (!model) return SPINNER
  return (
    <div className="docxengine-host h-full min-h-[480px]">
      <Suspense fallback={SPINNER}>
        <WordEditor
          documentModel={model}
          onDocumentChange={setModel}
          readOnly={true}
          showToolbar={false}
          onDocumentError={(e) => setError(e instanceof Error ? e.message : String(e))}
        />
      </Suspense>
    </div>
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
    <div className="visioengine-host h-full min-h-[480px]">
      <Suspense fallback={SPINNER}>
        <VisioViewer
          ref={setHandle}
          showToolbar={false}
        />
      </Suspense>
    </div>
  )
}

function XlsxViewer({ data, fileName }: { data: ArrayBuffer; fileName?: string }) {
  const [error, setError] = useState<string | null>(null)
  const content = useMemo(() => new Uint8Array(data.slice(0)), [data])
  if (error) return <ErrorNote msg={error} />
  return (
    <div className="xlsxengine-host h-full min-h-[480px]">
      <Suspense fallback={SPINNER}>
        <SpreadsheetEditor
          bytes={content}
          fileName={fileName}
          readOnly={true}
          showToolbar={false}
          showFormulaBar={false}
          onWorkbookError={(e) => setError(e instanceof Error ? e.message : String(e))}
        />
      </Suspense>
    </div>
  )
}
