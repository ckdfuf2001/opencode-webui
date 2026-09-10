import fs from 'fs/promises'
import path from 'path'
import { validatePath, getRawFileContent } from './files'
import { FILE_LIMITS } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

const PAGE_EXTENSIONS = new Set(['.html', '.htm'])
const WRAPPED_TEXT_EXTENSIONS = new Set(['.txt', '.log', '.json', '.md', '.markdown', '.csv', '.xml', '.yaml', '.yml'])
const ASSET_BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.vbs', '.ps1', '.msi', '.dll', '.lnk', '.reg',
])
const PAGE_MAX_BYTES = 2 * 1024 * 1024
const ASSET_MAX_BYTES = 8 * 1024 * 1024

const ASSET_MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
}

const BRIDGE_SCRIPT = `<script>window.opcode={_s:0,_p:{},call:function(m,a){var s=this;return new Promise(function(res,rej){var id=++s._s;s._p[id]={res:res,rej:rej};parent.postMessage({__opcode:1,id:id,method:m,args:a||{}},'*')})}};window.addEventListener('message',function(e){var d=e.data||{};if(!d||!d.__opcodeReply)return;var p=window.opcode._p[d.id];if(!p)return;delete window.opcode._p[d.id];if(d.ok)p.res(d.result);else p.rej(new Error(d.error||'bridge call failed'))});</script>`

export function getHtmlCodeDocument(html: string, title?: string): string {
  const withBridge = injectHead(html, BRIDGE_SCRIPT)
  return title?.trim() ? applyTitle(withBridge, title) : withBridge
}

export function assetBaseHref(userPath: string): string {
  const normalized = userPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : ''
  const encoded = dir.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/')
  return encoded ? `/api/html-view/asset/${encoded}/` : '/api/html-view/asset/'
}

function injectHead(html: string, headContent: string): string {
  const match = html.match(/<head[^>]*>/i)
  if (match && match.index !== undefined) {
    const insertAt = match.index + match[0].length
    return html.slice(0, insertAt) + headContent + html.slice(insertAt)
  }
  return `<head>${headContent}</head>` + html
}

function wrapTextDocument(text: string, ext: string, title: string): string {
  let body = text
  if (ext === '.json') {
    try {
      body = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // JSON이 아니면 원문 그대로
    }
  }
  return `<html><head><meta charset="utf-8"><title>${escapeHtml(title.slice(0, 200))}</title><style>body{margin:0;background:#fff;color:#111}pre{margin:0;padding:16px;font:13px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}</style></head><body><pre>${escapeHtml(body.slice(0, 500000))}</pre></body></html>`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function applyTitle(html: string, title: string): string {
  const tag = `<title>${escapeHtml(title.slice(0, 200))}</title>`
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, tag)
  }
  return injectHead(html, tag)
}

export async function getHtmlViewPage(userPath: string, title?: string): Promise<{ html: string; resolvedPath: string }> {
  const ext = path.extname(userPath).toLowerCase()
  const wrapped = WRAPPED_TEXT_EXTENSIONS.has(ext)
  if (!PAGE_EXTENSIONS.has(ext) && !wrapped) {
    throw { message: 'Only .html/.htm/.txt/.json/.md and other text files can be viewed', statusCode: 400 }
  }
  const validated = validatePath(userPath)
  const [stats, content] = await Promise.all([
    fs.stat(validated).catch(() => null),
    getRawFileContent(userPath),
  ])
  if (!stats || !stats.isFile()) {
    throw { message: 'File or directory not found', statusCode: 404 }
  }
  const limit = FILE_LIMITS?.MAX_SIZE_BYTES ?? PAGE_MAX_BYTES
  const maxBytes = Math.min(limit, PAGE_MAX_BYTES)
  if (content.length > maxBytes) {
    throw { message: `HTML too large (max ${Math.round(maxBytes / 1024)}KB)`, statusCode: 400 }
  }
  let html = content.toString('utf8')
  if (wrapped) {
    html = wrapTextDocument(html, ext, title?.trim() || path.basename(userPath))
  }
  const headContent = `<base href="${assetBaseHref(userPath)}">` + BRIDGE_SCRIPT
  logger.info(`Serving html-view page for path: ${userPath}`)
  const injected = injectHead(html, headContent)
  return { html: title?.trim() ? applyTitle(injected, title) : injected, resolvedPath: validated }
}

export async function getHtmlViewAsset(userPath: string): Promise<{ data: Buffer; mimeType: string }> {
  const ext = path.extname(userPath).toLowerCase()
  const wrapped = WRAPPED_TEXT_EXTENSIONS.has(ext)
  if (!wrapped && ASSET_BLOCKED_EXTENSIONS.has(ext)) {
    throw { message: `Asset type not allowed: ${ext || '(none)'}`, statusCode: 403 }
  }
  const validated = validatePath(userPath)
  const stats = await fs.stat(validated).catch(() => null)
  if (!stats || !stats.isFile()) {
    throw { message: 'File or directory not found', statusCode: 404 }
  }
  if (stats.size > ASSET_MAX_BYTES) {
    throw { message: 'Asset too large', statusCode: 400 }
  }
  const data = await getRawFileContent(userPath)
  if (wrapped) {
    const title = path.basename(userPath)
    const doc = wrapTextDocument(data.toString('utf8'), ext, title)
    const injected = injectHead(doc, `<base href="${assetBaseHref(userPath)}">` + BRIDGE_SCRIPT)
    return { data: Buffer.from(injected, 'utf8'), mimeType: 'text/html; charset=utf-8' }
  }
  return { data, mimeType: ASSET_MIME[ext] ?? 'application/octet-stream' }
}
