import { Hono } from 'hono'
import { opencodeServerManager } from '../services/opencode-single-server'
import { ensureServerAuth } from '../services/opencode-auth'

export function createPtyRoutes() {
  const app = new Hono()

  app.get('/:sessionId/:messageId/:partId/stream', async (c) => {
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const partId = c.req.param('partId')
    const directory = c.req.query('directory')

    const opencodeUrl = opencodeServerManager.getUrl()

    let prev = ''
    let closed = false

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const send = (event: string, data: string) => {
          if (closed) return
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
        }

        c.req.raw.signal?.addEventListener('abort', () => {
          closed = true
          try { controller.close() } catch {}
        })

        // Poll opencode for tool part output
        while (!closed) {
          try {
            const url = new URL(`${opencodeUrl}/session/${sessionId}/message/${messageId}`)
            if (directory) url.searchParams.set('directory', directory)
            const res = await fetch(url.toString(), { headers: ensureServerAuth({}) as Record<string, string> })
            if (res.ok) {
              const msg = await res.json() as { info?: { id: string }; parts?: Array<{ id: string; type: string; tool?: string; state?: { status?: string; output?: string } }> }
              const part = msg.parts?.find((p) => p.id === partId)
              if (part) {
                const cur = typeof part.state?.output === 'string' ? part.state.output : ''
                if (cur.length > prev.length && cur.startsWith(prev)) {
                  const delta = cur.slice(prev.length)
                  prev = cur
                  send('pty.delta', JSON.stringify({ delta, output: cur }))
                } else if (cur.length > prev.length) {
                  // Non-prefix (e.g. reset) — send full
                  prev = cur
                  send('pty.delta', JSON.stringify({ delta: cur, output: cur }))
                }
                if (part.state?.status === 'completed' || part.state?.status === 'error') {
                  send('pty.done', JSON.stringify({ output: cur, status: part.state.status }))
                  break
                }
              }
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 200))
        }
        try { controller.close() } catch {}
      },
      cancel() { closed = true },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    })
  })

  return app
}
