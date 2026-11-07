import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'

const { createCollabRoutes } = await import('../../src/routes/collab')

let base = ''
let stop = async (): Promise<void> => {}

async function get(pathname: string): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${base}/api/collab/resolve?path=${encodeURIComponent(pathname)}`)
  let json: unknown = null
  try { json = await r.json() } catch { /* ignore */ }
  return { status: r.status, json }
}

describe('GET /api/collab/resolve (C6c-a0: 서버가 URL 해석의 단일 진실)', () => {
  beforeAll(async () => {
    const root = new Hono()
    root.route('/api/collab', createCollabRoutes())
    const server = serve({ fetch: root.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((resolve, reject) => {
      server.on('listening', () => resolve())
      server.on('error', (e) => reject(e))
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    stop = async () => {
      await new Promise<void>((resolve2, reject2) => server.close((e) => (e ? reject2(e) : resolve2())))
    }
  })
  afterAll(async () => { await stop() })

  it('file URL을 그대로 돌려준다', async () => {
    const r = await get('/edit/repos/demo/report.docx')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ kind: 'file', path: 'repos/demo/report.docx' })
  })

  it('한글·공백 파일명을 왕복한다', async () => {
    const r = await get('/edit/repos/demo/%ED%95%9C%EA%B8%80%20%EB%B3%B4%EA%B3%A0%EC%84%9C.docx')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ kind: 'file', path: 'repos/demo/한글 보고서.docx' })
  })

  it('attachment URL을 parent/part로 나눈다', async () => {
    const r = await get('/edit/kdbl1/embed-pdf.pptx/-/ppt/embeddings/plain.docx')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ kind: 'attachment', parentPath: 'kdbl1/embed-pdf.pptx', part: 'ppt/embeddings/plain.docx' })
  })

  it('한글 부모 경로의 attachment도 나눈다', async () => {
    const r = await get('/edit/%EC%84%9C%EB%A5%98%EA%B3%A0/%EB%B3%B4%EA%B3%A0%EC%84%9C.pptx/-/ppt/embeddings/%ED%95%9C%EA%B8%80.docx')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({
      kind: 'attachment',
      parentPath: '서류고/보고서.pptx',
      part: 'ppt/embeddings/한글.docx',
    })
  })

  it('형식에 안 맞으면 400이다', async () => {
    const r = await get('/edit/')
    expect(r.status).toBe(400)
  })
})
