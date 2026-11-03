import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { workspaceDir } from './helpers/env'
import { openEditor } from './helpers/viewer'

/**
 * C5-1 후속 S1: solo(혼자) 편집에서 개체 이동이 자동 저장되어야 한다.
 * red 근거: identity 미발급 브라우저에서는 rooms() self-match가 실패해
 * scheduleAutosave가 조용히 skip된다 (probe P4/P5: objects/move는 가는데
 * /api/collab/save가 never).
 *
 * 통과 기준: solo Edit에서 ole shape 드래그 후 25초 안에
 *  1) POST /api/collab/save 발생 + officeSaveDone(ok:true),
 *  2) 디스크 drawing 앵커가 실제로 이동 + embeddings/oleObject 보존.
 */
const FIX = 'e2e/collab/fixtures/ole'

async function mkRepo(localPath: string, files: string[]): Promise<void> {
  const mk = await fetch('http://127.0.0.1:5011/api/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localPath }),
  }).then((r) => r.json())
  const repoId = (mk as { id?: number })?.id
  if (!repoId) throw new Error('repo created failed')
  const dir = path.join(workspaceDir(), 'repos', localPath)
  fs.mkdirSync(dir, { recursive: true })
  for (const n of files) fs.copyFileSync(path.join(FIX, n), path.join(dir, n))
}

async function openViaWorkspace(page: Page, name: string, seg: string): Promise<void> {
  await page.goto('/?collabDebug=1', { waitUntil: 'domcontentloaded', timeout: 30000 })
  for (let i = 0; i < 6; i++) {
    try {
      await page.getByTitle('Workspace').waitFor({ timeout: 12000 })
      break
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }
  }
  for (let i = 0; i < 5; i++) {
    await page.getByTitle('Workspace').click({ timeout: 20000 })
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, {
        timeout: 10000,
      })
      break
    } catch {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(2000)
    }
  }
  for (let i = 0; i < 8; i++) {
    const has = await page.evaluate(
      ([n, s]) =>
        [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => {
          const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
          return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
        }),
      [name, seg],
    )
    if (has) break
    await page.evaluate((s) => {
      const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
      const folder =
        rows.find((r) => {
          const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
          return p === (s as string) || p.endsWith('/' + (s as string))
        }) ?? rows.find((r) => !(r.getAttribute('data-path') || '').includes('.'))
      const inner = folder?.querySelector('div.flex-1') ?? folder?.querySelector('div')
      inner?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, seg)
    await page.waitForTimeout(2000)
  }
  const marked = await page.evaluate(
    ([n, s]) => {
      const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
      rows.forEach((e) => e.removeAttribute('data-s1-target'))
      const row = rows.find((r) => {
        const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
        return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
      })
      if (!row) return false
      row.setAttribute('data-s1-target', '1')
      return true
    },
    [name, seg],
  )
  if (!marked) throw new Error(`row not found ${seg}/${name}`)
  await page.locator('[data-s1-target="1"]').locator('span', { hasText: name }).first().click({ timeout: 20000 })
  await page.waitForSelector('.xlsxengine-host', { timeout: 60000 })
  await page.waitForTimeout(4000)
}

/** shadow를 뚫고 .xg-obj-unsupported를 찾는다 (light DOM 셀렉터는 못 찾는다). */
async function oleShapeRect(page: Page): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate(() => {
    const deep = (root: ParentNode, acc: Element[] = [], depth = 0): Element[] => {
      if (depth > 8) return acc
      for (const el of [...((root as Element).querySelectorAll?.('*') ?? [])]) {
        acc.push(el)
        const sr = (el as HTMLElement).shadowRoot
        if (sr) deep(sr, acc, depth + 1)
      }
      return acc
    }
    const host = document.querySelector('.xlsxengine-host')
    if (!host) return null
    const cands = deep(host).filter((e) => (e.className?.toString?.() ?? '').includes('xg-obj-unsupported'))
    const vis = cands
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .sort((a, b) => a.width * a.height - b.width * b.height)
    const r = vis[0]
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
  })
}

async function drawingAnchor(abs: string): Promise<string> {
  const buf = fs.readFileSync(abs)
  const zip = await JSZip.loadAsync(buf)
  const names = Object.keys(zip.files).filter((n) => n.includes('drawing1'))
  if (names.length === 0) return 'NO-DRAWING'
  const txt = await zip.files[names[0]!]!.async('string')
  const m = txt.match(/<xdr:from>.*?<\/xdr:to>/s)
  return m ? m[0].slice(0, 300) : 'NO-ANCHOR'
}

async function hasOleObject(abs: string): Promise<boolean> {
  const buf = fs.readFileSync(abs)
  const zip = await JSZip.loadAsync(buf)
  return Object.keys(zip.files).some((n) => n.includes('oleObject'))
}

test.describe('S1: xlsx solo ole autosave', () => {
  test('S1: solo Edit에서 ole shape 이동이 자동 저장된다', async ({ page }) => {
    // 신원 미발급 fresh 브라우저(시드 없음)가 전제다.
    const seg = `s1solo-${Date.now().toString(36)}`
    await mkRepo(seg, ['embed-docx.xlsx'])
    fs.copyFileSync(
      path.join(workspaceDir(), 'repos', seg, 'embed-docx.xlsx'),
      path.join(workspaceDir(), 'repos', seg, 'probe.xlsx'),
    )
    const abs = path.join(workspaceDir(), 'repos', seg, 'probe.xlsx')
    const anchorBefore = await drawingAnchor(abs)

    const saves: Array<{ t: number; url: string }> = []
    const dones: unknown[] = []
    let moveOkAt = 0
    page.on('request', (r) => {
      const u = r.url()
      if (u.includes('/api/collab/save') && r.method() === 'POST') saves.push({ t: Date.now(), url: u })
    })
    page.on('response', (res) => {
      const u = res.url()
      if (u.includes('/objects/') && u.endsWith('/move')) moveOkAt = Date.now()
    })
    await page.exposeFunction('__s1Done', (d: unknown) => {
      dones.push(d)
    })
    await openEditor(page, `${seg}/probe.xlsx`)
    await page.evaluate(() => {
      window.addEventListener('officeSaveDone', (e) =>
        (window as unknown as { __s1Done?: (d: unknown) => void }).__s1Done?.((e as CustomEvent).detail),
      )
    })

    const target = await oleShapeRect(page)
    expect(target, 'ole unsupported shape visible').toBeTruthy()
    const rectBefore = { ...target! }
    const cx = target!.x + target!.w / 2
    const cy = target!.y + target!.h / 2
    await page.mouse.click(cx, cy)
    await page.waitForTimeout(800)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 120, cy + 90, { steps: 15 })
    await page.mouse.up()
    await page.waitForTimeout(1000)
    const rectAfter = await oleShapeRect(page)
    expect(rectAfter, 'shape rect readable after drag').toBeTruthy()
    expect(
      { x: rectAfter!.x, y: rectAfter!.y },
      'drag visibly moved the shape (same session)',
    ).not.toEqual({ x: rectBefore.x, y: rectBefore.y })

    // 저장 폴링은 move 이후 저장만 셈한다 (클릭 시점의 이른 저장이
    // 먼저 와도 디스크 판정은 move 반영분으로 한다).
    await expect
      .poll(() => saves.filter((s) => moveOkAt > 0 && s.t > moveOkAt).length, {
        timeout: 25000,
        intervals: [500],
      })
      .toBeGreaterThan(0)
    expect(dones.filter((d) => (d as { ok?: boolean })?.ok === true).length).toBeGreaterThan(0)

    const anchorAfter = await drawingAnchor(abs)
    expect(anchorAfter, 'drawing anchor moved on disk').not.toBe(anchorBefore)
    expect(await hasOleObject(abs), 'oleObject preserved after solo save').toBe(true)
  })

  test('S2: 신원 미발급이면 편집 진입 시 자동 발급된다', async ({ page }) => {
    const seg = `s1id-${Date.now().toString(36)}`
    await mkRepo(seg, ['embed-docx.xlsx'])
    // C5-4 flag-day: 편집 진입은 /edit/* 직접 goto다.
    await openEditor(page, `${seg}/embed-docx.xlsx`)
    const id = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('collab-user')
        const p = raw ? (JSON.parse(raw) as { id?: unknown }) : null
        return typeof p?.id === 'string' ? p.id : null
      } catch {
        return null
      }
    })
    expect(id, 'collab-user id provisioned').toBeTruthy()
  })
})
