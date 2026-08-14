import { Hono } from 'hono'
import { z } from 'zod'
import { convertToPdf, extractDocumentText, editDocument, extractAttachment } from '../services/doc-converter'

const EDIT_OPERATIONS_SCHEMA = z.object({
  path: z.string().min(1),
  operations: z
    .array(
      z.object({
        op: z.enum(['replace', 'insert_after', 'insert_before', 'append', 'prepend', 'delete']),
        find: z.string().optional(),
        replace: z.string().optional(),
        text: z.string().optional(),
        occurrence: z.number().int().positive().optional(),
      })
    )
    .min(1),
})

export function createPreviewRoutes() {
  const app = new Hono()

  app.post('/edit', async (c) => {
    let parsed: z.infer<typeof EDIT_OPERATIONS_SCHEMA>
    try {
      parsed = EDIT_OPERATIONS_SCHEMA.parse(await c.req.json())
    } catch (error: any) {
      return c.json({ error: 'Invalid request body', details: error?.issues || [] }, 400)
    }
    try {
      const result = await editDocument(parsed.path, parsed.operations)
      return c.json(result)
    } catch (error: any) {
      return c.json({ error: error.message || 'Edit failed' }, error.statusCode || 500)
    }
  })

  app.post('/extract', async (c) => {
    let userPath: string
    let refresh = false
    try {
      const body = await c.req.json()
      userPath = body.path || ''
      refresh = body.refresh === true
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }
    if (!userPath) {
      return c.json({ error: 'Missing path' }, 400)
    }
    try {
      const result = await extractDocumentText(userPath, refresh)
      return c.json(result)
    } catch (error: any) {
      return c.json({ error: error.message || 'Extraction failed' }, error.statusCode || 500)
    }
  })

  app.get('/attachment', async (c) => {
    const userPath = c.req.query('path') || ''
    const index = Number(c.req.query('index') ?? '')
    if (!userPath || !Number.isInteger(index) || index < 0) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    try {
      const { data, fileName, mimeType } = await extractAttachment(userPath, index)
      return new Response(data, {
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Content-Length': String(data.length),
        },
      })
    } catch (error: any) {
      return c.json({ error: error.message || 'Attachment extraction failed' }, error.statusCode || 500)
    }
  })

  app.get('/pdf', async (c) => {
    const userPath = c.req.query('path') || ''
    if (!userPath) {
      return c.json({ error: 'Missing path' }, 400)
    }

    try {
      const refresh = c.req.query('refresh') === '1'
      const pdf = await convertToPdf(userPath, refresh)
      return new Response(pdf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
        },
      })
    } catch (error: any) {
      return c.json({ error: error.message || 'Conversion failed' }, error.statusCode || 500)
    }
  })

  return app
}