import type { Database } from 'bun:sqlite'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { getWorkspacePath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

export interface HtmlManagedPage {
  name: string
  kind: 'file' | 'code'
  path: string
  html: string
  updatedAt: number
}

const MAX_NAME_LENGTH = 120
const MAX_CODE_BYTES = 512 * 1024

interface HtmlPageRow {
  name: string
  kind: string
  path: string
  html: string
  updated_at: number
}

function rowToPage(row: HtmlPageRow): HtmlManagedPage {
  return {
    name: row.name,
    kind: row.kind === 'code' ? 'code' : 'file',
    path: row.path ?? '',
    html: row.html ?? '',
    updatedAt: row.updated_at,
  }
}

// 구버전 JSON 저장소(workspace/html-pages.json)가 있으면 DB로 1회 이관한다.
let jsonImportAttempted = false
function importLegacyJsonOnce(db: Database): void {
  if (jsonImportAttempted) return
  jsonImportAttempted = true
  const file = path.join(getWorkspacePath(), 'html-pages.json')
  if (!existsSync(file)) return
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO html_pages (name, kind, path, html, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    let imported = 0
    for (const p of parsed as Partial<HtmlManagedPage>[]) {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) continue
      const kind = p.kind === 'code' ? 'code' : 'file'
      stmt.run(p.name.trim().slice(0, MAX_NAME_LENGTH), kind, p.path ?? '', p.html ?? '', p.updatedAt ?? Date.now())
      imported++
    }
    logger.info(`Imported ${imported} html page(s) from legacy JSON store`)
    try {
      rmSync(file)
    } catch {}
  } catch (error) {
    logger.warn('Failed to import legacy html-pages JSON:', error)
  }
}

export function listHtmlPages(db: Database): HtmlManagedPage[] {
  importLegacyJsonOnce(db)
  const rows = db.prepare('SELECT name, kind, path, html, updated_at FROM html_pages ORDER BY name').all() as HtmlPageRow[]
  return rows.map(rowToPage)
}

export function getHtmlPage(db: Database, name: string): HtmlManagedPage | null {
  importLegacyJsonOnce(db)
  const key = name.trim()
  let row = db.prepare('SELECT name, kind, path, html, updated_at FROM html_pages WHERE name = ?').get(key) as HtmlPageRow | undefined
  if (!row) {
    row = db.prepare('SELECT name, kind, path, html, updated_at FROM html_pages WHERE LOWER(name) = LOWER(?)').get(key) as HtmlPageRow | undefined
  }
  return row ? rowToPage(row) : null
}

export function upsertHtmlPage(db: Database, input: { name: string; kind: 'file' | 'code'; path?: string; html?: string }): HtmlManagedPage {
  const name = input.name.trim().slice(0, MAX_NAME_LENGTH)
  if (!name) throw { message: 'Name is required', statusCode: 400 }
  if (input.kind === 'file' && !input.path?.trim()) throw { message: 'Path is required for file pages', statusCode: 400 }
  const html = input.kind === 'code' ? (input.html ?? '') : ''
  if (Buffer.byteLength(html, 'utf8') > MAX_CODE_BYTES) throw { message: 'Code too large', statusCode: 400 }
  const now = Date.now()
  db.prepare(
    `INSERT INTO html_pages (name, kind, path, html, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, path = excluded.path, html = excluded.html, updated_at = excluded.updated_at`,
  ).run(name, input.kind, input.kind === 'file' ? input.path!.trim() : '', html, now)
  logger.info(`Saved html managed page: ${name} (${input.kind})`)
  return { name, kind: input.kind, path: input.kind === 'file' ? input.path!.trim() : '', html, updatedAt: now }
}

export function deleteHtmlPage(db: Database, name: string): boolean {
  const key = name.trim()
  const result = db.prepare('DELETE FROM html_pages WHERE name = ? OR LOWER(name) = LOWER(?)').run(key, key)
  return result.changes > 0
}
