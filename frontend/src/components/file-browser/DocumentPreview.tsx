import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, AlertCircle, Maximize2, Minimize2, X, ZoomIn, ZoomOut, User, Users, Clock, Paperclip, File } from 'lucide-react'
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
  if (ext === 'docx') return 'docx'
  if (ext === 'doc') return 'doc'
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx'
  if (ext === 'pptx') return 'pptx'
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
    if (!enabled) return
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
    }
  }, [path, enabled])

  return { data, status, error }
}

function useConvertedPdf(path: string, refreshKey = 0, enabled = true) {
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled) {
      setStatus('unavailable')
      return
    }
    let cancelled = false
    setStatus('loading')
    setData(null)
    setError('')
    const refresh = refreshKey > 0 ? '&refresh=1' : ''
    fetch(`${API_BASE_URL}/api/preview/pdf?path=${encodeURIComponent(path)}${refresh}`)
      .then(async (res) => {
        if (res.status === 503) {
          if (!cancelled) setStatus('unavailable')
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        if (!cancelled) {
          setData(buf)
          setStatus('ready')
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to convert document')
          setStatus('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [path, refreshKey, enabled])

  return { data, status, error }
}

function useExtractedText(path: string, refreshKey = 0, enabled = true) {
  const [data, setData] = useState<{ text: string; fileName?: string; msg?: ExtractedMsg } | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled) {
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
    }
  }, [path, refreshKey, enabled])

  return { data, status, error }
}

function PdfPage({ pdf, pageNumber, zoom = 1 }: { pdf: any; pageNumber: number; zoom?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const page = await pdf.getPage(pageNumber)
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
      if (!cancelled) setLoading(false)
    })().catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [pdf, pageNumber, zoom])

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

function DocumentShell({ fileName, pageCount, children }: { fileName?: string; pageCount?: number; children: (fullscreen: boolean, zoom: number) => ReactNode }) {
  const [fullscreen, setFullscreen] = useState(false)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    setZoom(1)
  }, [fileName])

  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))

  const content = (
    <div className="flex-1 min-h-0 overflow-auto bg-muted/40">
      {children(fullscreen, zoom)}
    </div>
  )

  const title = fileName ?? 'Document preview'

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col bg-background">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-background flex-shrink-0">
          <span className="text-sm text-foreground font-medium truncate">{title}</span>
          <div className="flex items-center gap-1">
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={() => setZoom(1)} />
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setFullscreen(false)} title="Exit fullscreen">
              <Minimize2 className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setFullscreen(false)} title="Close">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
        {content}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-[200px]">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-background flex-shrink-0">
        <span className="text-xs text-muted-foreground truncate">
          {title}
          {pageCount != null ? ` · ${pageCount} pages` : ''}
        </span>
        <div className="flex items-center gap-1">
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={() => setZoom(1)} />
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setFullscreen(true)} title="Fullscreen">
            <Maximize2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      {content}
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
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load PDF')
      }
    })()
    return () => {
      cancelled = true
      doc?.destroy?.()
    }
  }, [data])

  if (error) return <ErrorNote msg={error} />
  if (!pdf) return SPINNER

  const pages = Array.from({ length: pdf.numPages }, (_, i) => i + 1)
  return (
    <DocumentShell fileName={fileName} pageCount={pdf.numPages}>
      {(fullscreen, zoom) => (
        <div key={`${fullscreen}:${zoom}`} className="p-3 space-y-3">
          {pages.map((n) => (
            <PdfPage key={n} pdf={pdf} pageNumber={n} zoom={zoom} />
          ))}
        </div>
      )}
    </DocumentShell>
  )
}

export function DocumentPreview({ file, refreshKey = 0 }: { file: FileInfo; refreshKey?: number }) {
  const kind = detectDocKind(file.name)
  const converted = useConvertedPdf(file.path, refreshKey, kind !== 'msg')
  const extracted = useExtractedText(file.path, refreshKey, kind === 'msg')

  const hasClientFallback = kind ? CONVERTABLE_CLIENT_KINDS.has(kind) : false
  const { data: raw, status: rawStatus, error: rawError } = useRawFile(file.path, hasClientFallback && converted.status !== 'ready')

  if (!kind) return null

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
  } else if (converted.status === 'loading') {
    body = SPINNER
  } else if (converted.status === 'ready' && converted.data) {
    body = <PdfViewer data={converted.data} fileName={file.name} />
  } else if (hasClientFallback) {
    if (rawStatus === 'loading') {
      body = SPINNER
    } else if (rawStatus === 'ready' && raw) {
      if (kind === 'pdf') body = <PdfViewer data={raw} fileName={file.name} />
      else if (kind === 'docx') body = <DocxViewer data={raw} fileName={file.name} />
      else if (kind === 'xlsx') body = <XlsxViewer data={raw} fileName={file.name} />
      else body = <PptxViewer data={raw} fileName={file.name} />
    } else if (rawStatus === 'error') {
      body = <ErrorNote msg={rawError} />
    } else {
      body = null
    }
  } else {
    body = <ConversionRequiredNote msg={converted.error} />
  }

  return (
    <div className="h-full flex flex-col min-h-0 min-w-0 overflow-hidden">
      {body}
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
      {(_fullscreen, zoom) => (
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
    }
  }, [data])

  if (error) return <ErrorNote msg={error} />
  if (!html) return SPINNER
  return (
    <DocumentShell fileName={fileName}>
      {(_fullscreen, zoom) => (
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

function sheetToHtmlWithHeaders(ws: { '!ref'?: string; [key: string]: any }, XLSX: any, styles?: any[]) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
  const startCol = range.s.c
  const startRow = range.s.r
  const endCol = range.e.c
  const endRow = range.e.r
  const headerCells: string[] = ['<th class="xlsx-corner"></th>']
  for (let c = startCol; c <= endCol; c++) headerCells.push(`<th class="xlsx-col-head"><span>${XLSX.utils.encode_col(c)}</span></th>`)
  const rows: string[] = [`<tr>${headerCells.join('')}</tr>`]
  for (let r = startRow; r <= endRow; r++) {
    const cells: string[] = [`<th class="xlsx-row-head"><span>${r + 1}</span></th>`]
    for (let c = startCol; c <= endCol; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = ws[addr]
      const val = cell ? XLSX.utils.format_cell(cell) : ''
      const cls = cell && cell.t === 'n' ? ' class="xlsx-num"' : ''
      cells.push(`<td${cls}${cellBorderInline(cell, styles)}>${escapeHtml(val)}</td>`)
    }
    rows.push(`<tr>${cells.join('')}</tr>`)
  }
  return `<table class="xlsx-table">${rows.join('')}</table>`
}

function XlsxViewer({ data, fileName }: { data: ArrayBuffer; fileName?: string }) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const mod = await import('xlsx')
        const XLSX = mod.default ?? mod
        const wb = XLSX.read(new Uint8Array(data), { type: 'array', cellStyles: true }) as any
        const sheetStyles: any[] = wb.Styles || []
        const parts = wb.SheetNames.map((name: string) => {
          const ws = wb.Sheets[name]
          return '<div class="xlsx-sheet"><h3>' + name + '</h3>' + sheetToHtmlWithHeaders(ws, XLSX, sheetStyles) + '</div>'
        })
        if (!cancelled) setHtml(parts.join(''))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to parse spreadsheet')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [data])

  if (error) return <ErrorNote msg={error} />
  if (!html) return SPINNER
  return (
    <DocumentShell fileName={fileName}>
      {(_fullscreen, zoom) => (
        <div className="xlsx-preview p-3" style={{ zoom }} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </DocumentShell>
  )
}

const PPTX_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'

function parseSlideXml(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const paras = Array.from(doc.getElementsByTagNameNS(PPTX_NS, 'p'))
  return paras
    .map((p) => Array.from(p.getElementsByTagNameNS(PPTX_NS, 't')).map((t) => t.textContent ?? '').join(''))
    .filter((line) => line.trim())
}

function PptxViewer({ data, fileName }: { data: ArrayBuffer; fileName?: string }) {
  const [slides, setSlides] = useState<{ index: number; lines: string[] }[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const JSZip = (await import('jszip')).default
        const zip = await JSZip.loadAsync(data)
        const slideNames = Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => {
            const na = parseInt(a.match(/slide(\d+)\.xml/)![1], 10)
            const nb = parseInt(b.match(/slide(\d+)\.xml/)![1], 10)
            return na - nb
          })
        const result: { index: number; lines: string[] }[] = []
        for (const name of slideNames) {
          const xml = await zip.files[name].async('string')
          result.push({
            index: parseInt(name.match(/slide(\d+)\.xml/)![1], 10),
            lines: parseSlideXml(xml),
          })
        }
        if (!cancelled) setSlides(result)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to parse presentation')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [data])

  if (error) return <ErrorNote msg={error} />
  if (slides.length === 0) return SPINNER

  return (
    <DocumentShell fileName={fileName}>
      {(_fullscreen, zoom) => (
        <div className="p-3 space-y-3" style={{ zoom }}>
          {slides.map((slide) => (
            <div key={slide.index} className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Slide {slide.index}</p>
              {slide.lines.length > 0 ? (
                <ul className="space-y-1">
                  {slide.lines.map((line, i) => (
                    <li key={i} className="text-sm text-foreground">
                      {line}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground italic">(no text)</p>
              )}
            </div>
          ))}
        </div>
      )}
    </DocumentShell>
  )
}
