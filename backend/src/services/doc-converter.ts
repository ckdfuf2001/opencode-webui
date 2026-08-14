import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../utils/logger'
import { validatePath } from './files'

const CONVERTER_PORT = parseInt(process.env.DOC_CONVERTER_PORT || '8765', 10)
const CONVERTER_BASE = `http://127.0.0.1:${CONVERTER_PORT}`
const SUPPORTED_EXTENSIONS = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])

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
    const scriptPath = path.join(process.cwd(), 'backend', 'scripts', 'doc_converter.py')
    const child = spawn('python', [scriptPath], {
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

export async function extractDocumentText(userPath: string, refresh = false): Promise<{ text: string; fileName: string }> {
  const resolved = validatePath(userPath)

  const ext = path.extname(resolved).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(ext) && ext !== '.pdf' && ext !== '.msg') {
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

  return { text: body.text, fileName: body.fileName || path.basename(resolved) }
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

export function stopConverter(): void {
  if (converterProcess) {
    converterProcess.kill()
    converterProcess = null
  }
}
