import { useEffect, useMemo, useRef, useState, type ReactNode, Suspense, lazy } from 'react'
import { Loader2, AlertCircle, ZoomIn, ZoomOut, User, Users, Clock, Paperclip, File } from 'lucide-react'
import 'pptx-react-viewer/styles.css'

const PowerPointViewer = lazy(() =>
  import('pptx-react-viewer').then((m) => ({ default: m.PowerPointViewer })),
)
import type { FileInfo } from '@/types/files'
import { API_BASE_URL } from '@/config'
import { Button } from '@/components/ui/button'

type DocKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'doc' | 'xls' | 'ppt' | 'msg'

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
  // office 문서(docx/xlsx/pptx)는 네이티브(빠른 보기) 우선 — PDF 변환 없이 바로 본다.
  // PDF가 필요하면 토글로 서버 변환을 켠다.
  const isOfficeNative = kind === 'docx' || kind === 'xlsx' || kind === 'pptx'
  const [pdfMode, setPdfMode] = useState(false)
  useEffect(() => { setPdfMode(false) }, [file.path])
  const converted = useConvertedPdf(file.path, refreshKey, kind !== 'msg' && (!isOfficeNative || pdfMode))
  const extracted = useExtractedText(file.path, refreshKey, kind === 'msg')

  const hasClientFallback = kind ? CONVERTABLE_CLIENT_KINDS.has(kind) : false
  const { data: raw, status: rawStatus, error: rawError } = useRawFile(
    file.path,
    isOfficeNative ? !pdfMode : (hasClientFallback && converted.status !== 'ready'),
  )

  if (!kind) return null

  const renderRawBody = (): ReactNode => {
    if (rawStatus === 'loading') return SPINNER
    if (rawStatus === 'ready' && raw) {
      if (kind === 'pdf') return <PdfViewer data={raw} fileName={file.name} />
      if (kind === 'docx') return <DocxViewer data={raw} fileName={file.name} />
      if (kind === 'xlsx') return <XlsxViewer data={raw} fileName={file.name} />
      return <PptxViewer data={raw} fileName={file.name} />
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
              빠른 보기
            </button>
            <button
              type="button"
              onClick={() => setPdfMode(true)}
              className={`h-6 text-xs px-2 rounded ${pdfMode ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              title="서버에서 PDF로 변환해서 보기"
            >
              PDF
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

function DocxViewer({ data, fileName }: { data: ArrayBuffer; fileName?: string }) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const mod = await import('mammoth')
        const mammoth = mod.default ?? mod
        const result = await mammoth.convertToHtml({ arrayBuffer: data.slice(0) })
        if (!cancelled) setHtml(result.value)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to parse document')
      }
    })()
    return () => {
      cancelled = true
      setHtml('')
      setError(null)
    }
  }, [data])

  if (error) return <ErrorNote msg={error} />
  if (!html) return SPINNER
  return (
    <DocumentShell fileName={fileName}>
      {(zoom) => (
        <div className="p-4" style={{ zoom }}>
          <div className="docx-preview prose-enhanced max-w-full" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
    </DocumentShell>
  )
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function cellBorderInline(cell: any, styles: any[] | undefined): string {
  if (!cell || cell.s == null || !styles) return ''
  const style = styles[cell.s]
  const border = style?.border
  if (!border) return ''
  const color = 'color-mix(in srgb, var(--color-border) 60%, transparent)'
  const parts: string[] = []
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const b = border[side]
    if (b && b.style && b.style > 0) {
      parts.push(`border-${side}:1px solid ${color}`)
    }
  }
  return parts.length ? ` style="${parts.join(';')}"` : ''
}

function sheetToHtmlWithHeaders(
  ws: { '!ref'?: string; [key: string]: any },
  XLSX: any,
  styles?: any[],
  imagesByCell?: Map<string, { src: string; name: string; w: number; h: number }[]>,
  colWidthsPx?: number[],
) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
  const startCol = range.s.c
  const startRow = range.s.r
  const endCol = range.e.c
  const endRow = range.e.r
  const headerCells: string[] = ['<th class="xlsx-corner"></th>']
  const colgroup: string[] = ['<col style="width:32px">']
  let totalWidth = 32
  for (let c = startCol; c <= endCol; c++) {
    headerCells.push(`<th class="xlsx-col-head"><span>${XLSX.utils.encode_col(c)}</span></th>`)
    const w = colWidthsPx?.[c - startCol]
    if (w && w > 0) {
      const wi = Math.round(w)
      colgroup.push(`<col style="width:${wi}px">`)
      totalWidth += wi
    } else {
      colgroup.push('<col>')
    }
  }
  const rows: string[] = [`<tr>${headerCells.join('')}</tr>`]
  for (let r = startRow; r <= endRow; r++) {
    const cells: string[] = [`<th class="xlsx-row-head"><span>${r + 1}</span></th>`]
    for (let c = startCol; c <= endCol; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = ws[addr]
      const val = cell ? XLSX.utils.format_cell(cell) : ''
      const cls = cell && cell.t === 'n' ? ' class="xlsx-num"' : ''
      const inline = imagesByCell?.get(`${r},${c}`)
      let extra = ''
      if (inline) {
        for (const im of inline) {
          const size =
            im.w > 0 && im.h > 0
              ? `width:${Math.round(im.w)}px;height:${Math.round(im.h)}px;`
              : 'max-width:220px;max-height:160px;'
          extra += `<br><img src="${im.src}" alt="${escapeHtml(im.name)}" style="${size}object-fit:contain;max-width:none" loading="lazy"/>`
        }
      }
      cells.push(`<td${cls}${cellBorderInline(cell, styles)}>${escapeHtml(val)}${extra}</td>`)
    }
    rows.push(`<tr>${cells.join('')}</tr>`)
  }
  return {
    // 엑셀처럼 고정폭 + 넘침 표시: 내용이 길면 옆 빈 셀 위로 그냥 보인다 (열이 늘어나지 않음).
    // fixed는 확정 width가 있어야 먹으므로 합산폭을 명시한다 (width:auto면 내용 기준으로 풀린다).
    html: `<table class="xlsx-table" style="table-layout:fixed;width:${totalWidth}px"><colgroup>${colgroup.join('')}</colgroup>${rows.join('')}</table>`,
    startRow,
    startCol,
    endRow,
    endCol,
  }
}

function XlsxViewer({ data, fileName }: { data: ArrayBuffer; fileName?: string }) {
  const [sheets, setSheets] = useState<{ name: string; html: string; images: { src: string; name: string }[]; skippedImages: number }[]>([])
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const urls: string[] = []
    ;(async () => {
      try {
        const mod = await import('xlsx')
        const XLSX = mod.default ?? mod
        const JSZip = (await import('jszip')).default
        const zip = await JSZip.loadAsync(data)
        const wb = XLSX.read(new Uint8Array(data), { type: 'array', cellStyles: true }) as any
        const sheetStyles: any[] = wb.Styles || []
        // workbook rel 체인으로 시트별 drawing 연결 (이미지 귀속용)
        const sheetDrawings = await mapSheetDrawings(zip).catch(() => new Map<string, string>())
        const parts = []
        for (const name of wb.SheetNames as string[]) {
          const ws = wb.Sheets[name]
          const colW = columnPixelWidths(ws)
          const rowH = rowPixelHeights(ws)
          const table = sheetToHtmlWithHeaders(ws, XLSX, sheetStyles, undefined, colWidthsFor(ws, XLSX))
          const loaded = await loadSheetImages(zip, sheetDrawings.get(name), urls).catch(() => ({ images: [], skipped: 0 }))
          // 표시 크기: oneCell은 ext 그대로, twoCell은 셀 span으로 계산, 둘 다 없으면 축소 표시.
          const spanPx = (im: SheetImage): { w: number; h: number } | null => {
            if (im.isTwoCell && im.toCol > im.col && im.toRow > im.row) {
              let w = 0
              for (let c = im.col; c < im.toCol; c++) w += colW(c)
              let h = 0
              for (let r = im.row; r < im.toRow; r++) h += rowH(r)
              if (w > 0 && h > 0) return { w, h }
            }
            if (im.extW > 0 && im.extH > 0) return { w: im.extW, h: im.extH }
            return null
          }
          // 앵커가 표 범위 안이면 셀 안에 직접 넣고, 나머지만 하단 갤러리로.
          const imagesByCell = new Map<string, { src: string; name: string; w: number; h: number }[]>()
          const gallery: { src: string; name: string }[] = []
          for (const im of loaded.images) {
            const sized = spanPx(im)
            if (im.col >= table.startCol && im.col <= table.endCol && im.row >= table.startRow && im.row <= table.endRow && sized) {
              const key = `${im.row},${im.col}`
              const list = imagesByCell.get(key) ?? []
              list.push({ src: im.src, name: im.name, w: sized.w, h: sized.h })
              imagesByCell.set(key, list)
            } else {
              gallery.push({ src: im.src, name: im.name })
            }
          }
          const html = imagesByCell.size > 0
            ? sheetToHtmlWithHeaders(ws, XLSX, sheetStyles, imagesByCell, colWidthsFor(ws, XLSX)).html
            : table.html
          parts.push({ name, html, images: gallery, skippedImages: loaded.skipped })
        }
        if (!cancelled) {
          setSheets(parts)
          setActive(0)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to parse spreadsheet')
      }
    })()
    return () => {
      cancelled = true
      setSheets([])
      setActive(0)
      setError(null)
      for (const u of urls) {
        try { URL.revokeObjectURL(u) } catch {}
      }
    }
  }, [data])

  if (error) return <ErrorNote msg={error} />
  if (sheets.length === 0) return SPINNER
  const cur = sheets[Math.min(active, sheets.length - 1)]!
  return (
    <DocumentShell fileName={fileName}>
      {(zoom) => (
        <div className="xlsx-preview" style={{ zoom }}>
          {sheets.length > 1 && (
            <div className="flex items-center gap-1 px-3 pt-2 overflow-x-auto border-b border-border bg-background sticky top-0 left-0 z-10">
              {/* thead 행/열 헤더(sticky top-0, z-1/2)보다 위 + 가로 스크롤에도 고정 — 내용만 움직인다 */}
              {sheets.map((s, i) => (
                <button
                  key={`${s.name}-${i}`}
                  type="button"
                  onClick={() => setActive(i)}
                  title={s.name}
                  className={`shrink-0 max-w-[160px] truncate px-2.5 py-1.5 text-xs rounded-t-md border border-b-0 transition-colors ${
                    i === active
                      ? 'bg-muted font-medium text-foreground border-border'
                      : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <div className="p-3" dangerouslySetInnerHTML={{ __html: cur.html }} />
          {(cur.images.length > 0 || cur.skippedImages > 0) && (
            <div className="px-3 pb-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                Images ({cur.images.length}{cur.skippedImages > 0 ? `, ${cur.skippedImages} unrenderable` : ''})
              </p>
              <div className="flex flex-wrap gap-2">
                {cur.images.map((img, i) => (
                  <a key={i} href={img.src} target="_blank" rel="noreferrer" title={img.name}>
                    <img
                      src={img.src}
                      alt={img.name}
                      className="max-h-40 max-w-full rounded border border-border bg-white object-contain"
                      loading="lazy"
                    />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </DocumentShell>
  )
}

/** workbook rel 체인으로 시트 이름 → drawing 경로를 연결한다. */
async function mapSheetDrawings(zip: any): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const readXml = async (path: string): Promise<Document | null> => {
    const f = zip.files[path]
    if (!f || f.dir) return null
    try {
      return new DOMParser().parseFromString(await f.async('string'), 'application/xml')
    } catch {
      return null
    }
  }
  const relsOf = async (path: string): Promise<Map<string, string>> => {
    // path: 'xl/worksheets/sheet1.xml' → rels: 'xl/worksheets/_rels/sheet1.xml.rels'
    const slash = path.lastIndexOf('/')
    const relsPath = `${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`
    const doc = await readXml(relsPath)
    const map = new Map<string, string>()
    if (!doc) return map
    const rels = Array.from(doc.getElementsByTagName('Relationship'))
    for (const r of rels) {
      const id = r.getAttribute('Id')
      const target = r.getAttribute('Target')
      if (id && target) map.set(id, target)
    }
    return map
  }
  const resolve = (base: string, target: string): string => {
    // '../drawings/drawing1.xml' → base 디렉토리 기준 정규화
    const dir = base.slice(0, base.lastIndexOf('/'))
    const parts: string[] = []
    for (const seg of `${dir}/${target}`.split('/')) {
      if (seg === '..') parts.pop()
      else if (seg !== '.' && seg !== '') parts.push(seg)
    }
    return parts.join('/')
  }
  const wb = await readXml('xl/workbook.xml')
  if (!wb) return out
  const wbRels = await relsOf('xl/workbook.xml')
  const sheets = Array.from(wb.getElementsByTagName('sheet'))
  for (const s of sheets) {
    const name = s.getAttribute('name')
    const rid = s.getAttribute('r:id')
    if (!name || !rid) continue
    const wsTarget = wbRels.get(rid)
    if (!wsTarget) continue
    const wsPath = resolve('xl/workbook.xml', wsTarget)
    const wsRels = await relsOf(wsPath)
    for (const [, target] of wsRels) {
      if (/drawing/i.test(target)) {
        out.set(name, resolve(wsPath, target))
        break
      }
    }
  }
  return out
}

const RENDERABLE_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/** 시트 표시 범위에 맞춘 열 너비(px) 배열. */
function colWidthsFor(ws: any, XLSX: any): number[] {
  const colW = columnPixelWidths(ws)
  let startCol = 0
  let endCol = 0
  try {
    const range = XLSX.utils.decode_range(ws?.['!ref'] || 'A1')
    startCol = range.s.c
    endCol = range.e.c
  } catch {}
  const out: number[] = []
  for (let c = startCol; c <= endCol; c++) out.push(colW(c))
  return out
}

/** 열 너비 px (wch→px 근사, Calibri 11 기준). */
function columnPixelWidths(ws: any): (c: number) => number {
  const cols = ws?.['!cols'] as Array<{ wch?: number }> | undefined
  return (c: number) => {
    const wch = cols?.[c]?.wch ?? 8.43
    return Math.max(8, Math.round(wch * 7 + 5))
  }
}

/** 행 높이 px (hpt→px, 기본 15pt). */
function rowPixelHeights(ws: any): (r: number) => number {
  const rows = ws?.['!rows'] as Array<{ hpt?: number }> | undefined
  return (r: number) => {
    const hpt = rows?.[r]?.hpt ?? 15
    return Math.max(8, Math.round((hpt * 96) / 72))
  }
}

/** drawing의 embedded 이미지를 blob URL로 꺼낸다 (브라우저 표시 불가 형식은 세기만). */
interface SheetImage {
  src: string
  name: string
  col: number
  row: number
  toCol: number
  toRow: number
  extW: number
  extH: number
  isTwoCell: boolean
}

async function loadSheetImages(
  zip: any,
  drawingPath: string | undefined,
  urls: string[],
): Promise<{ images: SheetImage[]; skipped: number }> {
  const images: SheetImage[] = []
  let skipped = 0
  if (!drawingPath) return { images, skipped }
  const f = zip.files[drawingPath]
  if (!f || f.dir) return { images, skipped }
  const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml')
  // drawing rels에서 embed id → media 경로
  const slash = drawingPath.lastIndexOf('/')
  const relsPath = `${drawingPath.slice(0, slash)}/_rels/${drawingPath.slice(slash + 1)}.rels`
  const relsFile = zip.files[relsPath]
  const relMap = new Map<string, string>()
  if (relsFile && !relsFile.dir) {
    try {
      const relsDoc = new DOMParser().parseFromString(await relsFile.async('string'), 'application/xml')
      for (const r of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
        const id = r.getAttribute('Id')
        const target = r.getAttribute('Target')
        if (id && target) relMap.set(id, target)
      }
    } catch {}
  }
  const num = (el: Element | undefined | null, tag: string): number => {
    if (!el) return -1
    const n = el.getElementsByTagName(tag)[0]
    if (!n?.textContent) return -1
    const v = parseInt(n.textContent, 10)
    return Number.isNaN(v) ? -1 : v
  }
  const dir = drawingPath.slice(0, slash)
  const seen = new Set<string>()
  // 앵커 단위로 훑어 셀 좌표(xdr:from col/row)를 함께 잡는다.
  const anchors = [
    ...Array.from(doc.getElementsByTagName('xdr:twoCellAnchor')),
    ...Array.from(doc.getElementsByTagName('xdr:oneCellAnchor')),
  ]
  for (const anchor of anchors) {
    const isTwoCell = (anchor as Element).tagName === 'xdr:twoCellAnchor'
    const from = anchor.getElementsByTagName('xdr:from')[0]
    const col = num(from, 'xdr:col')
    const row = num(from, 'xdr:row')
    const to = anchor.getElementsByTagName('xdr:to')[0]
    const toCol = num(to, 'xdr:col')
    const toRow = num(to, 'xdr:row')
    // 표시 크기 (없으면 셀에 맞게 축소 표시)
    let w = -1
    let h = -1
    const pic = anchor.getElementsByTagName('xdr:pic')[0]
    const ext = pic ? firstChild(firstChild(pic, 'xdr:spPr'), 'a:ext') : undefined
    if (ext) {
      w = emuPx(ext.getAttribute('cx'))
      h = emuPx(ext.getAttribute('cy'))
    }
    const blips = Array.from(anchor.getElementsByTagName('a:blip'))
    for (const blip of blips) {
      const embed = blip.getAttribute('r:embed')
      if (!embed || seen.has(embed)) continue
      seen.add(embed)
      const target = relMap.get(embed)
      if (!target) continue
      const parts: string[] = []
      for (const seg of `${dir}/${target}`.split('/')) {
        if (seg === '..') parts.pop()
        else if (seg !== '.' && seg !== '') parts.push(seg)
      }
      const mediaPath = parts.join('/')
      const mediaFile = zip.files[mediaPath]
      if (!mediaFile || mediaFile.dir) continue
      const ext = (mediaPath.split('.').pop() ?? '').toLowerCase()
      const mime = RENDERABLE_IMAGE_MIME[ext]
      if (!mime) {
        skipped += 1
        continue
      }
      const buf: Uint8Array = await mediaFile.async('uint8array')
      const blob = new Blob([buf.slice()], { type: mime })
      const src = URL.createObjectURL(blob)
      urls.push(src)
      images.push({ src, name: mediaPath.split('/').pop() ?? mediaPath, col, row, toCol, toRow, extW: w, extH: h, isTwoCell })
    }
  }
  return { images, skipped }
}

/** EMU → px (96dpi). */
const emuPx = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '')
  return Number.isNaN(n) ? 0 : n / (914400 / 96)
}

function firstChild(el: Element | undefined | null, tag: string): Element | null {
  if (!el) return null
  const list = el.getElementsByTagName(tag)
  return list.length > 0 ? (list[0] as Element) : null
}

function PptxViewer({ data, fileName }: { data: ArrayBuffer; fileName?: string }) {
  const content = useMemo(() => new Uint8Array(data.slice(0)), [data])
  return (
    <div className="h-full min-h-0">
      <Suspense fallback={SPINNER}>
        <PowerPointViewer content={content} fileName={fileName} canEdit={false} />
      </Suspense>
    </div>
  )
}
