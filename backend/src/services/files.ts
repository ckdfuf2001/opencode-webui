import fs from 'fs/promises'
import path from 'path'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { logger } from '../utils/logger'

import { 
  readFileContent, 
  readFileAsBase64,
  writeFileContent, 
  fileExists, 
  deletePath, 
  getFileStats, 
  listDirectory 
} from './file-operations'
import { FILE_LIMITS, getReposPath, DEFAULT_BLOCKED_UPLOAD_EXTENSIONS } from '@opencode-webui/shared'
import type { ChunkedFileInfo, PatchOperation } from '@opencode-webui/shared'

const SHARED_WORKSPACE_BASE = getReposPath()

const DEFAULT_BLOCKED_UPLOADS = new Set(
  (DEFAULT_BLOCKED_UPLOAD_EXTENSIONS ?? []).map((e) => e.toLowerCase()),
)

function normalizeBlockedExtensions(input: unknown): Set<string> {
  if (!Array.isArray(input)) return DEFAULT_BLOCKED_UPLOADS
  const out = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    let e = raw.trim().toLowerCase()
    if (!e) continue
    if (!e.startsWith('.')) e = `.${e}`
    out.add(e)
  }
  return out
}

export { DEFAULT_BLOCKED_UPLOADS }

interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mimeType?: string
  content?: string
  children?: FileInfo[]
  lastModified: Date
  workspaceRoot?: string
}

interface FileUploadResult {
  name: string
  path: string
  size: number
  mimeType: string
}

const TRANSIENT_ERROR_CODES = new Set(['ENOENT', 'EBUSY', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE'])

function isTransientError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    TRANSIENT_ERROR_CODES.has(String((error as { code?: unknown }).code))
  )
}

async function withRetry<T>(fn: () => Promise<T>, retries = 4, baseDelayMs = 150): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= retries || !isTransientError(error)) throw error
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * (attempt + 1)))
    }
  }
}

export async function getRawFileContent(userPath: string): Promise<Buffer> {
  const validatedPath = validatePath(userPath)
  logger.info(`Getting raw file content for path: ${userPath} -> ${validatedPath}`)
  
  try {
    return await withRetry(async () => {
      const exists = await fileExists(validatedPath)
      if (!exists) {
        throw Object.assign(new Error('File does not exist'), { code: 'ENOENT' })
      }
      
      const stats = await getFileStats(validatedPath)
      if (stats.isDirectory) {
        throw new Error('Path is a directory')
      }
      
      return await fs.readFile(validatedPath)
    })
  } catch (error) {
    logger.error(`Failed to read raw file content ${validatedPath}:`, error)
    throw { message: 'File not found or cannot be read', statusCode: 404 }
  }
}

export async function getFile(userPath: string): Promise<FileInfo> {
  const validatedPath = validatePath(userPath)
  logger.info(`Getting file for path: ${userPath} -> ${validatedPath}`)
  
  try {
    return await withRetry(async () => {
      // Check if path exists
      const exists = await fileExists(validatedPath)
      if (!exists) {
        throw Object.assign(new Error('Path does not exist'), { code: 'ENOENT' })
      }
      
      // Get file stats
      const stats = await getFileStats(validatedPath)
      
      if (stats.isDirectory) {
        // It's a directory - list contents
        const entries = await listDirectory(validatedPath)
        const children: FileInfo[] = []
        
        for (const entry of entries) {
          children.push({
            name: entry.name,
            path: path.join(userPath, entry.name),
            isDirectory: entry.isDirectory,
            size: entry.size,
            lastModified: entry.lastModified,
          })
        }
        
        return {
          name: path.basename(validatedPath),
          path: userPath,
          isDirectory: true,
          size: 0,
          children: children.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
              return a.isDirectory ? -1 : 1
            }
            return a.name.localeCompare(b.name)
          }),
          lastModified: stats.lastModified,
          workspaceRoot: SHARED_WORKSPACE_BASE,
        }
      } else {
        // It's a file - get content
        let content = ''
        let mimeType = getMimeType(validatedPath, new Uint8Array())
        
        if (stats.size < FILE_LIMITS.MAX_SIZE_BYTES) {
          try {
            const mimeType = getMimeType(validatedPath, new Uint8Array())
            
            if (mimeType.startsWith('image/') || !mimeType.startsWith('text/')) {
              content = await readFileAsBase64(validatedPath)
            } else {
              const fileOutput = await readFileContent(validatedPath)
              content = Buffer.from(fileOutput, 'utf8').toString('base64')
            }
          } catch (error) {
            logger.warn(`Failed to read file content: ${error}`)
          }
        }
        
        return {
          name: path.basename(validatedPath),
          path: userPath,
          isDirectory: false,
          size: stats.size,
          mimeType,
          content,
          lastModified: stats.lastModified,
        }
      }
    })
  } catch (error) {
    logger.error(`Failed to access path ${validatedPath}:`, error)
    throw { message: 'File or directory not found', statusCode: 404 }
  }
}

export async function getFileStat(userPath: string): Promise<{ exists: boolean; isDirectory: boolean; name: string; size: number; lastModified?: Date }> {
  const validatedPath = validatePath(userPath)
  const exists = await fileExists(validatedPath)
  if (!exists) {
    return { exists: false, isDirectory: false, name: path.basename(validatedPath), size: 0 }
  }
  const stats = await getFileStats(validatedPath)
  return {
    exists: true,
    isDirectory: stats.isDirectory,
    name: path.basename(validatedPath),
    size: stats.size,
    lastModified: stats.lastModified,
  }
}

export async function uploadFile(userPath: string, file: File, blockedExtensions?: unknown): Promise<FileUploadResult> {
  if (file.size > FILE_LIMITS.MAX_UPLOAD_SIZE_BYTES) {
    throw { message: `File too large (max ${FILE_LIMITS.MAX_UPLOAD_SIZE_BYTES} bytes)`, statusCode: 400 }
  }

  const fileName = file.name || path.basename(userPath)
  const ext = path.extname(fileName).toLowerCase()
  const blocked = blockedExtensions === undefined ? DEFAULT_BLOCKED_UPLOADS : normalizeBlockedExtensions(blockedExtensions)
  if (ext && blocked.has(ext)) {
    throw { message: `File type not allowed: ${fileName}`, statusCode: 400 }
  }
  
  const validatedPath = validatePath(userPath)
  // T15: 저장 파일명 정규화 — 공백·괄호 등은 셸 계열 도구와 따옴표 없는
  // 멘션에서 말썽이므로 `_`로 치환한다 (한글 등 유니코드 파일명은 유지).
  // 충돌 접미사는 기존 `name (1).ext` 대신 `name_1.ext` 형식으로 합친다.
  const sluggedName = slugUploadName(fileName)
  const fullPath = await resolveUniquePath(validatedPath, sluggedName)
  const savedName = path.basename(fullPath)
  
  const buffer = await file.arrayBuffer()
  
  await writeFileContent(fullPath, Buffer.from(buffer))
  
  return {
    name: savedName,
    path: path.join(userPath, savedName),
    size: file.size,
    mimeType: file.type || getMimeType(file.name, new Uint8Array()),
  }
}

export function slugUploadName(fileName: string): string {
  let ext = path.extname(fileName)
  // '...'처럼 점만 있는 이름은 확장자로 보지 않는다
  if (ext && !/^\.[A-Za-z0-9가-힣]+$/.test(ext)) ext = ''
  let base = ext ? path.basename(fileName, ext) : fileName
  base = base
    .replace(/[^A-Za-z0-9가-힣._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
  if (!base) base = 'file'
  return `${base}${ext.toLowerCase()}`
}

async function resolveUniquePath(dirPath: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let candidate = path.join(dirPath, fileName)
  let counter = 1
  while (await fileExists(candidate)) {
    candidate = path.join(dirPath, `${base}_${counter}${ext}`)
    counter++
  }
  return candidate
}

export async function createFileOrFolder(userPath: string, body: { type: 'file' | 'folder', content?: string }): Promise<FileInfo> {
  const validatedPath = validatePath(userPath)
  
  if (body.type === 'folder') {
  await fs.mkdir(validatedPath, { recursive: true })
  return {
    name: path.basename(validatedPath),
    path: userPath,
    isDirectory: true,
    size: 0,
    lastModified: new Date(),
  }
} else {
  const content = body.content || ''
  
  if (content) {
    await writeFileContent(validatedPath, content)
  } else {
    await fs.writeFile(validatedPath, '')
  }
  
  return {
    name: path.basename(validatedPath),
    path: userPath,
    isDirectory: false,
    size: content.length,
    lastModified: new Date(),
  }
}
}

export async function deleteFileOrFolder(userPath: string): Promise<void> {
  const validatedPath = validatePath(userPath)
  
  await deletePath(validatedPath)
}

export async function renameOrMoveFile(userPath: string, body: { newPath: string }): Promise<FileInfo> {
  const oldValidatedPath = validatePath(userPath)
  const newValidatedPath = validatePath(body.newPath)
  
  // Create parent directory if needed
  await fs.mkdir(path.dirname(newValidatedPath), { recursive: true })
  
  // Move/rename file
  await fs.rename(oldValidatedPath, newValidatedPath)
  
  // Get stats of new file
  const stats = await getFileStats(newValidatedPath)
  
  return {
    name: path.basename(newValidatedPath),
    path: body.newPath,
    isDirectory: stats.isDirectory,
    size: stats.size,
    lastModified: stats.lastModified,
  }
}

const SEARCH_IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build'])

export interface FileSearchDetail {
  name: string
  path: string
  isDirectory: boolean
  size: number
  lastModified: Date
}

export async function searchFiles(basePath: string, query: string): Promise<string[]>;
export async function searchFiles(basePath: string, query: string, opts: { details: true }): Promise<FileSearchDetail[]>;
export async function searchFiles(
  basePath: string,
  query: string,
  opts?: { details?: boolean },
): Promise<string[] | FileSearchDetail[]> {
  const validatedPath = validatePath(basePath)
  const q = query.trim().toLowerCase()
  const details = opts?.details === true
  const results: string[] = []
  const detailed: FileSearchDetail[] = []

  if (!q) {
    const entries = await listDirectory(validatedPath)
    const sorted = entries
      .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    if (details) {
      const rawBase = basePath.replace(/\\/g, '/').replace(/\/+$/, '')
      const base = rawBase === '.' ? '' : rawBase
      return sorted.map((entry): FileSearchDetail => ({
        name: entry.name,
        path: [base, entry.name].filter(Boolean).join('/'),
        isDirectory: entry.isDirectory,
        size: entry.size ?? 0,
        lastModified: entry.lastModified ?? new Date(0),
      }))
    }
    return sorted.map((entry) => entry.name)
  }

  const rawBase = basePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const joinBase = rawBase === '.' ? '' : rawBase
  const pushResult = (relPath: string, entry: { isDirectory: boolean; size?: number; lastModified?: Date }): void => {
    if (results.length >= 200) return
    results.push(relPath)
    if (details) {
      detailed.push({
        name: relPath,
        path: [joinBase, relPath].filter(Boolean).join('/'),
        isDirectory: entry.isDirectory,
        size: entry.size ?? 0,
        lastModified: entry.lastModified ?? new Date(0),
      })
    }
  }

  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof listDirectory>>
    try {
      entries = await listDirectory(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= 200) return
      if (SEARCH_IGNORED_DIRS.has(entry.name)) continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (relPath.toLowerCase().includes(q)) {
        pushResult(relPath, entry)
      }
      if (entry.isDirectory) {
        await walk(entry.path, relPath)
      }
    }
  }

  await walk(validatedPath, '')
  // 파일명(경로 마지막 세그먼트) 매칭을 먼저, 경로만 매칭된 결과는 그 다음
  const order = results.map((rel, i) => {
    const base = rel.split('/').pop()?.toLowerCase() ?? ''
    return { i, rank: base.includes(q) ? 0 : 1, rel }
  })
  order.sort((a, b) => a.rank - b.rank || a.rel.localeCompare(b.rel))
  if (details) {
    const byRel = new Map(detailed.map((d) => [d.name, d] as const))
    return order.map((o) => byRel.get(o.rel)).filter((d): d is FileSearchDetail => !!d)
  }
  return order.map((o) => o.rel)
}

export function validatePath(userPath: string): string {
  // aaa\chat_uploads\image (3).png 처럼 백슬래시·공백·괄호 포함 경로도 워크스페이스 기준으로 정규화
  const withForward = userPath.replace(/\\/g, '/')
  const normalized = path.normalize(withForward).replace(/^(\.\.(\/|\\|$))+/, '')
  const resolved = path.resolve(SHARED_WORKSPACE_BASE, normalized)
  
  const basePath = path.resolve(SHARED_WORKSPACE_BASE)
  if (resolved !== basePath && !resolved.startsWith(basePath + path.sep)) {
    throw { message: 'Path traversal detected', statusCode: 403 }
  }
  
  return resolved
}

function getMimeType(filePath: string, _content: Uint8Array): string {
  const ext = path.extname(filePath).toLowerCase()
  
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.jsx': 'text/javascript',
    '.tsx': 'text/typescript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.doc': 'application/msword',
    '.xls': 'application/vnd.ms-excel',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.msg': 'application/vnd.ms-outlook',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
  }
  
  return mimeTypes[ext] || 'text/plain'
}

async function countFileLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let lineCount = 0
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    
    rl.on('line', () => { lineCount++ })
    rl.on('close', () => resolve(lineCount))
    rl.on('error', reject)
  })
}

async function readFileLines(filePath: string, startLine: number, endLine: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    let currentLine = 0
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    
    rl.on('line', (line) => {
      if (currentLine >= startLine && currentLine < endLine) {
        lines.push(line)
      }
      currentLine++
      if (currentLine >= endLine) {
        rl.close()
        stream.destroy()
      }
    })
    rl.on('close', () => resolve(lines))
    rl.on('error', reject)
  })
}

export async function getFileRange(userPath: string, startLine: number, endLine: number): Promise<ChunkedFileInfo> {
  const validatedPath = validatePath(userPath)
  logger.info(`Getting file range for path: ${userPath} lines ${startLine}-${endLine}`)
  
  return withRetry(async () => {
    const exists = await fileExists(validatedPath)
    if (!exists) {
      throw Object.assign(new Error('File does not exist'), { code: 'ENOENT' })
    }
    
    const stats = await getFileStats(validatedPath)
    if (stats.isDirectory) {
      throw { message: 'Path is a directory', statusCode: 400 }
    }
    
    const totalLines = await countFileLines(validatedPath)
    const clampedEnd = Math.min(endLine, totalLines)
    const lines = await readFileLines(validatedPath, startLine, clampedEnd)
    const mimeType = getMimeType(validatedPath, new Uint8Array())
    
    return {
      name: path.basename(validatedPath),
      path: userPath,
      isDirectory: false as const,
      size: stats.size,
      mimeType,
      lines,
      totalLines,
      startLine,
      endLine: clampedEnd,
      hasMore: clampedEnd < totalLines,
      lastModified: stats.lastModified,
    }
  })
}

export async function getFileTotalLines(userPath: string): Promise<number> {
  const validatedPath = validatePath(userPath)
  const exists = await fileExists(validatedPath)
  if (!exists) {
    throw { message: 'File does not exist', statusCode: 404 }
  }
  return countFileLines(validatedPath)
}

export async function applyFilePatches(userPath: string, patches: PatchOperation[]): Promise<{ success: boolean; totalLines: number }> {
  const validatedPath = validatePath(userPath)
  logger.info(`Applying ${patches.length} patches to: ${userPath}`)
  
  const exists = await fileExists(validatedPath)
  if (!exists) {
    throw { message: 'File does not exist', statusCode: 404 }
  }
  
  const content = await fs.readFile(validatedPath, 'utf8')
  const lines = content.split('\n')
  
  const sortedPatches = [...patches].sort((a, b) => b.startLine - a.startLine)
  
  for (const patch of sortedPatches) {
    const { type, startLine, endLine, content: patchContent } = patch
    
    switch (type) {
      case 'replace': {
        const end = endLine ?? startLine + 1
        const newLines = patchContent?.split('\n') ?? []
        lines.splice(startLine, end - startLine, ...newLines)
        break
      }
      case 'insert': {
        const newLines = patchContent?.split('\n') ?? []
        lines.splice(startLine, 0, ...newLines)
        break
      }
      case 'delete': {
        const end = endLine ?? startLine + 1
        lines.splice(startLine, end - startLine)
        break
      }
    }
  }
  
  await fs.writeFile(validatedPath, lines.join('\n'), 'utf8')
  
  return { success: true, totalLines: lines.length }
}