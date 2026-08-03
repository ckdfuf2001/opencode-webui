import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, AlertCircle, Maximize2, Minimize2, X } from 'lucide-react'
import type { FileInfo } from '@/types/files'
import { API_BASE_URL } from '@/config'
import { Button } from '@/components/ui/button'

type DocKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'doc' | 'xls' | 'ppt'

export function detectDocKind(name: string): DocKind | null {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (ext === 'doc') return 'doc'
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx'
  if (ext === 'pptx') return 'pptx'
  if (ext === 'ppt') return 'ppt'
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

function useConvertedPdf(path: string, refreshKey = 0) {
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
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
  }, [path, refreshKey])

  return { data, status, error }
}

function PdfPage({ pdf, pageNumber }: { pdf: any; pageNumber: number }) {
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
      const scale = avail > 0 ? Math.min(avail / base.width, 2) : 1
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
  }, [pdf, pageNumber])

  return (
    <div ref={wrapRef} className="w-full">
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

function DocumentShell({ fileName, pageCount, children }: { fileName?: string; pageCount?: number; children: (fullscreen: boolean) => ReactNode }) {
  const [fullscreen, setFullscreen] = useState(false)

  const content = (
    <div className="flex-1 min-h-0 overflow-auto bg-muted/40">
      {children(fullscreen)}
    </div>
  )

  const title = fileName ?? 'Document preview'

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col bg-background">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-background flex-shrink-0">
          <span className="text-sm text-foreground font-medium truncate">{title}</span>
          <div className="flex items-center gap-1">
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
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setFullscreen(true)} title="Fullscreen">
          <Maximize2 className="w-3.5 h-3.5" />
        </Button>
      </div>
      {content}
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
      {(fullscreen) => (
        <div key={fullscreen ? 'fullscreen' : 'panel'} className="p-3 space-y-3">
          {pages.map((n) => (
            <PdfPage key={n} pdf={pdf} pageNumber={n} />
          ))}
        </div>
      )}
    </DocumentShell>
  )
}

export function DocumentPreview({ file, refreshKey = 0 }: { file: FileInfo; refreshKey?: number }) {
  const kind = detectDocKind(file.name)
  const converted = useConvertedPdf(file.path, refreshKey)

  const hasClientFallback = kind ? CONVERTABLE_CLIENT_KINDS.has(kind) : false
  const { data: raw, status: rawStatus, error: rawError } = useRawFile(file.path, hasClientFallback && converted.status !== 'ready')

  if (!kind) return null

  let body: ReactNode
  if (converted.status === 'loading') {
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
      {() => (
        <div className="docx-preview p-4 prose-enhanced max-w-full" dangerouslySetInnerHTML={{ __html: html }} />
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

function sheetToHtmlWithHeaders(ws: { '!ref'?: string; [key: string]: any }, XLSX: any) {
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
      cells.push(`<td${cls}>${escapeHtml(val)}</td>`)
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
        const wb = XLSX.read(new Uint8Array(data), { type: 'array' })
        const parts = wb.SheetNames.map((name: string) => {
          const ws = wb.Sheets[name]
          return '<div class="xlsx-sheet"><h3>' + name + '</h3>' + sheetToHtmlWithHeaders(ws, XLSX) + '</div>'
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
      {() => <div className="xlsx-preview p-3" dangerouslySetInnerHTML={{ __html: html }} />}
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
      {() => (
        <div className="p-3 space-y-3">
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
