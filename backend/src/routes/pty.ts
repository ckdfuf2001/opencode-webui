import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { opencodeServerManager } from '../services/opencode-single-server'
import { ensureServerAuth } from '../services/opencode-auth'

export function createPtyRoutes() {
  const app = new Hono()

  // Direct PTY run for bash streaming (when opencode doesn't stream)
  app.get('/run', async (c) => {
    const command = c.req.query('command')
    const directory = c.req.query('directory')
    if (!command) return c.json({ error: 'command required' }, 400)

    let closed = false
    let proc: ReturnType<typeof spawn> | null = null
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const send = (event: string, data: string) => {
          if (closed) return
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
        }
        const killProc = () => {
          try { proc?.kill('SIGKILL') } catch {}
          proc = null
        }
        c.req.raw.signal?.addEventListener('abort', () => {
          closed = true
          killProc()
          try { controller.close() } catch {}
        })

        const isWin = process.platform === 'win32'
        const shell = isWin ? 'cmd.exe' : 'bash'
        const args = isWin ? ['/c', command] : ['-c', command]
        proc = spawn(shell, args, {
          cwd: directory || process.cwd(),
          env: process.env,
          windowsHide: true,
        })

        // 절대 상한 15분: 끝나지 않는 명령이 스트림·프로세스를 영원히 붙잡지 않게 한다.
        const capTimer = setTimeout(() => {
          if (closed) return
          send('pty.done', JSON.stringify({ timeout: true }))
          killProc()
          closed = true
          try { controller.close() } catch {}
        }, 15 * 60 * 1000)
        if (typeof (capTimer as unknown as { unref?: unknown }).unref === 'function') {
          (capTimer as unknown as { unref: () => void }).unref()
        }

        proc.stdout?.on('data', (chunk: Buffer) => {
          send('pty.delta', JSON.stringify({ delta: chunk.toString() }))
        })
        proc.stderr?.on('data', (chunk: Buffer) => {
          send('pty.delta', JSON.stringify({ delta: chunk.toString() }))
        })
        proc.on('close', (code) => {
          clearTimeout(capTimer)
          send('pty.done', JSON.stringify({ code }))
          try { controller.close() } catch {}
          closed = true
        })
        proc.on('error', (err) => {
          clearTimeout(capTimer)
          send('pty.done', JSON.stringify({ error: String(err) }))
          try { controller.close() } catch {}
          closed = true
        })
      },
      cancel() {
        closed = true
        try { proc?.kill('SIGKILL') } catch {}
        proc = null
      },
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

  app.get('/:sessionId/:messageId/:partId/stream', async (c) => {
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const partId = c.req.param('partId')
    const directory = c.req.query('directory')
    const intervalMs = Math.min(60000, Math.max(1000, Number(c.req.query('interval') ?? '1000') || 1000))

    const opencodeUrl = opencodeServerManager.getUrl()

    let prev = ''
    let closed = false
    // 폴링 루프 상한: 파트가 영원히 running이면 SSE가 절대 안 끝난다.
    // (메시지 truncate로 파트 소실·턴 hang 등) 절대 15분 + 파트 5회 연속 미발견 시 종료.
    const startedAt = Date.now()
    const MAX_STREAM_MS = 15 * 60 * 1000
    const MAX_MISSING = 5
    let missing = 0

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
          if (Date.now() - startedAt > MAX_STREAM_MS) {
            send('pty.done', JSON.stringify({ output: prev, status: 'timeout', timeout: true }))
            break
          }
          try {
            const url = new URL(`${opencodeUrl}/session/${sessionId}/message/${messageId}`)
            if (directory) url.searchParams.set('directory', directory)
            const res = await fetch(url.toString(), { headers: ensureServerAuth({}) as Record<string, string> })
            if (res.ok) {
              const msg = await res.json() as { info?: { id: string }; parts?: Array<{ id: string; type: string; tool?: string; state?: { status?: string; output?: string } }> }
              const part = msg.parts?.find((p) => p.id === partId) as { id: string; state?: { status?: string; output?: string; metadata?: { output?: string } } } | undefined
              if (!part) {
                missing++
                if (missing >= MAX_MISSING) {
                  send('pty.done', JSON.stringify({ output: prev, status: 'gone' }))
                  break
                }
              } else {
                missing = 0
                const cur = typeof part.state?.output === 'string' ? part.state.output : typeof part.state?.metadata?.output === 'string' ? part.state.metadata.output : ''
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
          await new Promise((r) => setTimeout(r, intervalMs))
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
