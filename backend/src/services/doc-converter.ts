import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../utils/logger'
import { validatePath } from './files'
import { resolveDocConverterCommand } from './doc-tools'

const CONVERTER_PORT = parseInt(process.env.DOC_CONVERTER_PORT || '8765', 10)
const CONVERTER_BASE = `http://127.0.0.1:${CONVERTER_PORT}`
const SUPPORTED_EXTENSIONS = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp'])

let converterProcess: ChildProcess | null = null
let starting: Promise<boolean> | null = null

export function isConvertibleDocument(userPath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(userPath).toLowerCase())
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init)
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.status, body }
}

function startConverterProcess(): Promise<boolean> {
  return new Promise((resolve) => {
    const converter = resolveDocConverterCommand()
    const child = spawn(converter.command, converter.args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    converterProcess = child
    child.stdout?.on('data', (data) => logger.debug(`[doc-converter] ${data}`))
    child.stderr?.on('data', (data) => logger.debug(`[doc-converter] ${data}`))
    child.on('exit', () => {
      if (converterProcess === child) converterProcess = null
    })

    let attempts = 0
    const poll = async () => {
      attempts += 1
      try {
        const { status } = await fetchJson(`${CONVERTER_BASE}/health`)
        if (status === 200) {
          logger.info('Document converter ready')
          return resolve(true)
        }
      } catch {
        // not up yet
      }
      if (attempts > 40) {
        logger.warn('Document converter failed to start')
        child.kill()
        if (converterProcess === child) converterProcess = null
        return resolve(false)
      }
      setTimeout(poll, 250)
    }
    setTimeout(poll, 400)
  })
}

async function ensureConverter(): Promise<boolean> {
  if (converterProcess) return true
  if (starting) return starting
  try {
    const { status } = await fetchJson(`${CONVERTER_BASE}/health`)
    if (status === 200) return true
  } catch {
    // converter not running
  }
  starting = startConverterProcess()
  try {
    return await starting
  } finally {
    starting = null
  }
}

export async function convertToPdf(userPath: string, refresh = false): Promise<Buffer> {
  const validatedPath = validatePath(userPath)
  if (!isConvertibleDocument(validatedPath)) {
    throw { message: 'Unsupported document type', statusCode: 400 }
  }

  const ready = await ensureConverter()
  if (!ready) {
    throw { message: 'Document conversion service is unavailable', statusCode: 503 }
  }

  const { status, body } = await fetchJson(`${CONVERTER_BASE}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: validatedPath, refresh }),
  })

  if (status !== 200 || !body?.pdfPath) {
    const message = body?.error || 'Document conversion failed'
    logger.error(`Document conversion failed for ${userPath}: ${message}`)
    throw { message, statusCode: 500 }
  }

  return fs.readFile(body.pdfPath)
}

export type ExtractedMessage = {
  html?: string
  attachments?: Array<{ name: string; size: number; cid: string; mime: string }>
}

export async function extractDocumentText(
  userPath: string,
  refresh = false
): Promise<{ text: string; fileName: string; msg?: ExtractedMessage; ocr?: { text: string; boxes: Array<{ text: string; left: number; top: number; width: number; height: number; conf: number }> } }> {
  let resolved = validatePath(userPath)

  const ext = path.extname(resolved).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(ext) && !IMAGE_EXTS.has(ext) && ext !== '.pdf' && ext !== '.msg') {
    throw { message: 'Unsupported document type', statusCode: 400 }
  }

  let isFile = false
  try {
    const stat = await fs.stat(resolved)
    isFile = stat.isFile()
  } catch {
    isFile = false
  }
  // 호환: 이전에 chat_uploads/file 처럼 레포 없이 보낸 경로가 있으면, 실제 파일은 aaa/chat_uploads/file 에 있으므로 탐색해서 찾는다
  // dev ↔ release workspace가 달라 파일을 못 찾는 경우도 대비해 여러 base를 시도
  const tryFind = async (base: string, rel: string): Promise<string | null> => {
    try {
      const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [] as any[])
      for (const e of entries as any[]) {
        if (!e.isDirectory()) continue
        const cand = path.join(base, e.name, rel)
        try {
          const s = await fs.stat(cand)
          if (s.isFile()) return cand
        } catch {}
      }
    } catch {}
    return null
  }
  if (!isFile && userPath.replace(/\\/g, '/').startsWith('chat_uploads/')) {
    try {
      const { getReposPath, getWorkspacePath } = await import('@opencode-webui/shared')
      const bases = new Set<string>([
        getReposPath(),
        path.join(getWorkspacePath(), 'repos'),
        path.resolve(process.cwd(), 'workspace', 'repos'),
        path.resolve(process.cwd(), '..', 'workspace', 'repos'),
        path.resolve(process.cwd(), 'release', 'workspace', 'repos'),
      ])
      for (const base of bases) {
        const found = await tryFind(base, userPath)
        if (found) { resolved = found; isFile = true; break }
      }
    } catch {}
  }
  // aaa/... 처럼 레포 포함 경로도 dev/release 간 차이로 못 찾을 수 있어 대체 base에서 재시도
  if (!isFile && userPath.replace(/\\/g, '/').includes('/')) {
    try {
      const { getWorkspacePath } = await import('@opencode-webui/shared')
      const norm = userPath.replace(/\\/g, '/')
      const cands = [
        path.join(getWorkspacePath(), 'repos', norm),
        path.resolve(process.cwd(), 'workspace', 'repos', norm),
        path.resolve(process.cwd(), '..', 'workspace', 'repos', norm),
        path.resolve(process.cwd(), 'release', 'workspace', 'repos', norm),
      ]
      for (const c of cands) {
        try {
          const s = await fs.stat(c)
          if (s.isFile()) { resolved = c; isFile = true; break }
        } catch {}
      }
    } catch {}
  }
  // src/file.ts 처럼 레포 없이 온 일반 파일도 모든 레포에서 탐색 (채팅은 레포 없이 보냄)
  if (!isFile) {
    try {
      const { getReposPath, getWorkspacePath } = await import('@opencode-webui/shared')
      const bases = new Set<string>([
        getReposPath(),
        path.join(getWorkspacePath(), 'repos'),
        path.resolve(process.cwd(), 'workspace', 'repos'),
        path.resolve(process.cwd(), '..', 'workspace', 'repos'),
        path.resolve(process.cwd(), 'release', 'workspace', 'repos'),
      ])
      for (const base of bases) {
        const found = await tryFind(base, userPath.replace(/\\/g, '/'))
        if (found) { resolved = found; isFile = true; break }
      }
    } catch {}
  }
  if (!isFile) {
    throw { message: 'File not found', statusCode: 404 }
  }

  const ready = await ensureConverter()
  if (!ready) {
    throw { message: 'Document conversion service is unavailable', statusCode: 503 }
  }

  const { status, body } = await fetchJson(`${CONVERTER_BASE}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: resolved, refresh }),
  })

  if (status !== 200 || typeof body?.text !== 'string') {
    const message = body?.error || 'Document text extraction failed'
    logger.error(`Document text extraction failed for ${userPath}: ${message}`)
    throw { message, statusCode: 500 }
  }

  return { text: body.text, fileName: body.fileName || path.basename(resolved), msg: body.msg, ocr: body.ocr }
}

export async function editDocument(
  userPath: string,
  operations: Array<Record<string, unknown>>
): Promise<{ fileName: string; results: Array<Record<string, unknown>> }> {
  const resolved = validatePath(userPath)

  const ext = path.extname(resolved).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw { message: 'Unsupported document type', statusCode: 400 }
  }

  let isFile = false
  try {
    const stat = await fs.stat(resolved)
    isFile = stat.isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    throw { message: 'File not found', statusCode: 404 }
  }

  const ready = await ensureConverter()
  if (!ready) {
    throw { message: 'Document conversion service is unavailable', statusCode: 503 }
  }

  const { status, body } = await fetchJson(`${CONVERTER_BASE}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: resolved, operations }),
  })

  if (status !== 200 || body?.edited !== true) {
    const message = body?.error || 'Document edit failed'
    logger.error(`Document edit failed for ${userPath}: ${message}`)
    throw { message, statusCode: 500 }
  }

  return { fileName: body.fileName || path.basename(resolved), results: body.results || [] }
}

export async function extractAttachment(
  userPath: string,
  index: number
): Promise<{ data: Buffer; fileName: string; mimeType: string }> {
  const resolved = validatePath(userPath)

  let isFile = false
  try {
    const stat = await fs.stat(resolved)
    isFile = stat.isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    throw { message: 'File not found', statusCode: 404 }
  }

  const ready = await ensureConverter()
  if (!ready) {
    throw { message: 'Document conversion service is unavailable', statusCode: 503 }
  }

  const res = await fetch(`${CONVERTER_BASE}/attachment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: resolved, index }),
  })

  if (!res.ok) {
    let message = 'Attachment extraction failed'
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // not JSON
    }
    logger.error(`Attachment extraction failed for ${userPath}: ${message}`)
    throw { message, statusCode: res.status === 404 ? 404 : 500 }
  }

  const data = Buffer.from(await res.arrayBuffer())
  const disposition = res.headers.get('Content-Disposition') || ''
  const fileName = decodeURIComponent(disposition.split("filename*=UTF-8''")[1] || '') || path.basename(resolved)
  const mimeType = res.headers.get('Content-Type') || 'application/octet-stream'
  return { data, fileName, mimeType }
}

export function stopConverter(): void {
  if (converterProcess) {
    converterProcess.kill()
    converterProcess = null
  }
}
