import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { getHtmlViewPage, getHtmlViewAsset, getHtmlCodeDocument } from '../services/html-view'
import { listHtmlPages, getHtmlPage, upsertHtmlPage, deleteHtmlPage } from '../db/html-page-queries'
import { logger } from '../utils/logger'

const UPSERT_SCHEMA = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['file', 'code']),
  path: z.string().max(1024).optional(),
  html: z.string().max(512 * 1024).optional(),
})

export function createHtmlViewRoutes(db: Database) {
  const app = new Hono()

  app.get('/pages', async (c) => {
    try {
      return c.json(listHtmlPages(db))
    } catch (error: any) {
      logger.error('Failed to list html pages:', error)
      return c.json({ error: 'Failed to list pages' }, 500)
    }
  })

  app.post('/pages', async (c) => {
    let body: z.infer<typeof UPSERT_SCHEMA>
    try {
      body = UPSERT_SCHEMA.parse(await c.req.json())
    } catch (error: any) {
      return c.json({ error: 'Invalid request body', details: error?.issues || [] }, 400)
    }
    try {
      const page = upsertHtmlPage(db, body)
      return c.json(page)
    } catch (error: any) {
      return c.json({ error: error.message || 'Failed to save page' }, error.statusCode || 500)
    }
  })

  app.delete('/pages', async (c) => {
    const name = c.req.query('name') || ''
    if (!name) return c.json({ error: 'Missing name query parameter' }, 400)
    try {
      if (!deleteHtmlPage(db, name)) return c.json({ error: 'Page not found' }, 404)
      return c.json({ success: true })
    } catch (error: any) {
      return c.json({ error: 'Failed to delete page' }, 500)
    }
  })

  app.get('/', async (c) => {
    const userPath = c.req.query('path') || ''
    const title = c.req.query('title') || undefined
    try {
      if (!userPath && title) {
        const page = getHtmlPage(db, title)
        if (!page) return c.json({ error: `Page not found: ${title}` }, 404)
        if (page.kind === 'code') {
          return new Response(getHtmlCodeDocument(page.html, page.name), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          })
        }
        const { html } = await getHtmlViewPage(page.path, page.name)
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      if (!userPath) return c.json({ error: 'Missing path query parameter' }, 400)
      const { html } = await getHtmlViewPage(userPath, title)
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    } catch (error: any) {
      logger.error('Failed to serve html-view page:', error)
      return c.json({ error: error.message || 'Failed to serve HTML' }, error.statusCode || 500)
    }
  })

  app.get('/asset/*', async (c) => {
    const userPath = c.req.path
      .replace(/^\/api\/html-view\/asset\//, '')
      .replace(/%2F/gi, '/')
      .split('/')
      .map((seg) => {
        try {
          return decodeURIComponent(seg)
        } catch {
          return seg
        }
      })
      .join('/')
    if (!userPath) return c.json({ error: 'Missing asset path' }, 400)
    try {
      const { data, mimeType } = await getHtmlViewAsset(userPath)
      return new Response(data, {
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=60',
          'Content-Length': String(data.length),
        },
      })
    } catch (error: any) {
      logger.error('Failed to serve html-view asset:', error)
      return c.json({ error: error.message || 'Failed to serve asset' }, error.statusCode || 500)
    }
  })

  return app
}
