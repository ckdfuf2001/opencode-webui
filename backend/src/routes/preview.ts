import { Hono } from 'hono'
import { convertToPdf } from '../services/doc-converter'

export function createPreviewRoutes() {
  const app = new Hono()

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