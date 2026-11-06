import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { absForRel, backendBase } from './helpers/env'
import { gotoApp, openEditor, openFile } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * W0: DOCX 동시편집 (C6).
 *
 * 0절: docx lib는 Yjs 협업 바인딩을 갖췄다
 * (`WordYjsCollaboration`, `startYjsCollaboration(session, options)` — element-api.d.ts,
 * `createCollabSession` — ooxml-core/dist/collab/session.d.ts).
 * 앱은 xlsx처럼 lib 세션 + tap transport로 우리 relay 방에 붙인다 (D48).
 * 방 운영(strict/ETag/baseHash/owner/flush/리셋)은 서버 공통 경로를 그대로 쓴다.
 *
 * 규칙: 디스크 파일이 원본, 저장은 owner 1명만.
 * DOCX 타이핑은 contenteditable 직접 입력 + header Save (c5-1 proven pattern).
 * 디스크 판정은 word/document.xml 마커.
 */

const FIXTURE = path.resolve('e2e/collab/fixtures/collab-features.docx')

interface Two {
  ctxA: BrowserContext
  ctxB: BrowserContext
  pageA: Page
  pageB: Page
}

async function freshDocx(slug: string, index: number): Promise<{ rel: string; abs: string; name: string; seg: string }> {
  // mkRepo 패턴: /api/repos 로 등록해야 워크스페이스 목록에 보인다 (view 모드 진입용).
  const seg = `${slug}-${Date.now().toString(36)}`
  const mk = (await fetch(`${backendBase()}/api/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localPath: seg }),
  }).then((r) => r.json())) as { id?: number }
  if (!mk?.id) throw new Error('repo create failed')
  const name = `${slug}-${index}.docx`
  const rel = `repos/${seg}/${name}`
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(FIXTURE, abs)
  return { rel, abs, name, seg }
}

async function twoPages(browser: Browser): Promise<Two> {
  const mk = async (user: { id: string; name: string; color: string }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, user)
    const page = await ctx.newPage()
    await gotoApp(page)
    return { ctx, page }
  }
  const a = await mk(ADA)
  const b = await mk(GRACE)
  return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
}

async function openDocxEditing(page: Page, rel: string): Promise<void> {
  await openEditor(page, rel.replace(/^repos\//, ''))
  await page.locator('docx-editor').first().waitFor({ timeout: 60000 })
  await page.locator('docx-editor [contenteditable="true"]').first().waitFor({ timeout: 60000 })
}

async function typeAtEnd(page: Page, marker: string): Promise<void> {
  const pm = page.locator('docx-editor [contenteditable="true"]').first()
  await pm.click({ timeout: 15000 })
  await page.keyboard.press('Control+End')
  await page.keyboard.type(marker, { delay: 20 })
}

async function docxDiskHas(abs: string, marker: string): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(abs))
    const f = zip.file('word/document.xml')
    if (!f) return false
    return (await f.async('string')).includes(marker)
  } catch {
    return false
  }
}

async function participantCount(fileName: string): Promise<number> {
  try {
    const res = await fetch(`${backendBase()}/api/collab/rooms`)
    const body = (await res.json()) as { rooms?: Array<{ rel?: string; participants?: unknown[] }> }
    const rooms = (body.rooms ?? []).filter((r) => (r.rel ?? '').endsWith(fileName))
    if (rooms.length === 0) return 0
    return rooms[0]?.participants?.length ?? 0
  } catch {
    return -1
  }
}

async function clickDocxSave(page: Page): Promise<void> {
  const saveBtn = page.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
  if ((await saveBtn.count()) > 0) await saveBtn.first().click({ timeout: 20000 })
}

test.describe('W0: DOCX 동시편집', () => {
  test('W0-1: 두 편집자가 같은 방에 있고 서로 보인다', async ({ browser }, testInfo) => {
    testInfo.setTimeout(240000)
    const f = await freshDocx('w01', 0)
    const t = await twoPages(browser)
    try {
      await openDocxEditing(t.pageA, f.rel)
      await openDocxEditing(t.pageB, f.rel)
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(2)
      // R-ribbon: joined + 피어 1명 이상이면 타이틀바 슬롯에 presence 1개.
      await expect(t.pageA.locator('[data-testid="collab-presence"]')).toHaveCount(1, { timeout: 60000 })
      await expect(t.pageB.locator('[data-testid="collab-presence"]')).toHaveCount(1, { timeout: 60000 })
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('W0-2: A 편집 → B에 반영 → owner 저장 → 디스크 word/document.xml', async ({ browser }, testInfo) => {
    testInfo.setTimeout(420000)
    const f = await freshDocx('w02', 0)
    const t = await twoPages(browser)
    try {
      await openDocxEditing(t.pageA, f.rel)
      await openDocxEditing(t.pageB, f.rel)
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(2)
      await typeAtEnd(t.pageA, 'w02-mark')
      const bEditable = t.pageB.locator('docx-editor [contenteditable="true"]').first()
      await expect.poll(() => bEditable.textContent(), { timeout: 60000, intervals: [1000] }).toContain('w02-mark')
      await clickDocxSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(docxDiskHas(f.abs, 'w02-mark')), { timeout: 90000, intervals: [1000] })
        .toBe(true)
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('W0-3: 디스크와 어긋난 방에는 붙지 않는다 (stale_room 복구)', async ({ browser }, testInfo) => {
    testInfo.setTimeout(420000)
    const f = await freshDocx('w03', 0)
    const t = await twoPages(browser)
    try {
      await openDocxEditing(t.pageA, f.rel)
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(1)
      await typeAtEnd(t.pageA, 'w03-mark')
      await clickDocxSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(docxDiskHas(f.abs, 'w03-mark')), { timeout: 90000, intervals: [1000] })
        .toBe(true)
      // 디스크를 외부에서 바꾼다 (stale_room 유발).
      const zip = await JSZip.loadAsync(fs.readFileSync(f.abs))
      const doc = await zip.file('word/document.xml')!.async('string')
      zip.file('word/document.xml', doc.replace('w03-mark', 'w03-external'))
      fs.writeFileSync(f.abs, await zip.generateAsync({ type: 'nodebuffer' }))
      // B가 붙으면 stale 경고를 보고 복구한다 (방 내용은 버리고 디스크 기준).
      await openDocxEditing(t.pageB, f.rel)
      const bEditable = t.pageB.locator('docx-editor [contenteditable="true"]').first()
      await expect.poll(() => bEditable.textContent(), { timeout: 90000, intervals: [1000] }).toContain('w03-external')
      await expect.poll(() => bEditable.textContent(), { timeout: 30000, intervals: [1000] }).not.toContain('w03-mark')
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('W0-4: viewer가 먼저 들어간 뒤 편집자가 seed하면 viewer가 따라온다', async ({ browser }, testInfo) => {
    testInfo.setTimeout(420000)
    const f = await freshDocx('w04', 0)
    const t = await twoPages(browser)
    try {
      // B가 보기 모드로 먼저 들어간다 (방 참가, seed 없음).
      await openFile(t.pageB, f.name, 'view', { folderSeg: f.seg })
      await t.pageB.locator('docx-editor').first().waitFor({ timeout: 60000 })
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(1)
      // A가 편집으로 들어와 seed+편집한다.
      await openDocxEditing(t.pageA, f.rel)
      await typeAtEnd(t.pageA, 'w04-mark')
    // Refresh-free check: the viewer renders synced content without reload.
    await expect(t.pageB.getByText('w04-mark').first()).toBeVisible({ timeout: 90000 })
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('W0-5: http(non-secure)에서도 열린다', async ({ browser }, testInfo) => {
    testInfo.setTimeout(240000)
    const f = await freshDocx('w05', 0)
    const t = await twoPages(browser)
    try {
      await openDocxEditing(t.pageA, f.rel)
      expect(new URL(t.pageA.url()).protocol).toBe('http:')
      await typeAtEnd(t.pageA, 'w05-mark')
      await clickDocxSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(docxDiskHas(f.abs, 'w05-mark')), { timeout: 90000, intervals: [1000] })
        .toBe(true)
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('W0-6: 동기화 안 되는 작업은 차단되고 토스트 1회', async ({ browser }, testInfo) => {
    // 구역/페이지 설정은 Yjs 방에서 동기화되지 않는다
    // (editor-host.d.ts canEditOutsideBody: "parts and page setup aren't synced").
    // 동시편집 중에는 리본 버튼을 숨기고 토스트 1회로 알린다.
    testInfo.setTimeout(240000)
    const f = await freshDocx('w06', 0)
    const t = await twoPages(browser)
    try {
      await openDocxEditing(t.pageA, f.rel)
      await openDocxEditing(t.pageB, f.rel)
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(2)
      // 페이지 설정 액션이 숨김 목록에 들어간다.
      await expect
        .poll(
          () =>
            t.pageA.evaluate(() => {
              const el = document.querySelector('docx-editor') as unknown as {
                hiddenActions?: readonly string[]
              } | null
              return el?.hiddenActions ?? null
            }),
          { timeout: 60000, intervals: [1000] },
        ).toContain('page-setup-dialog')
      // 차단 토스트가 1회 뜬다.
      await expect(
        t.pageA.locator('[data-sonner-toast]').filter({ hasText: '동시편집' }),
      ).toHaveCount(1, { timeout: 30000 })
      const hiddenOf = () =>
        t.pageA.evaluate(() => {
          const el = document.querySelector('docx-editor') as unknown as {
            hiddenActions?: readonly string[]
          } | null
          return el?.hiddenActions ?? null
        })
      // undo/redo 우회 불가: Yjs undoManager는 동기 범위(fragment/attributes/코멘트)만
      // 다루므로 숨김 목록이 유지되고 동기 경로가 산다.
      await t.pageA.locator('docx-editor [contenteditable="true"]').first().click({ timeout: 15000 })
      await t.pageA.keyboard.press('Control+z')
      await t.pageA.keyboard.press('Control+y')
      await expect.poll(() => hiddenOf(), { timeout: 30000, intervals: [1000] }).toContain('page-setup-dialog')
      await expect.poll(() => hiddenOf(), { timeout: 30000, intervals: [1000] }).toContain('track-changes')
      await expect.poll(() => hiddenOf(), { timeout: 30000, intervals: [1000] }).toContain('insert-footnote')
      await expect.poll(() => hiddenOf(), { timeout: 30000, intervals: [1000] }).toContain('page-borders')
      // 동기 코멘트 경로는 막지 않는다 (방 identity가 항상 shared → sharedComments=true).
      await expect.poll(() => hiddenOf(), { timeout: 30000, intervals: [1000] }).not.toContain('add-comment')
      // 동기 경로 생존: 마커가 B에 보인다.
      await typeAtEnd(t.pageA, 'w06-mark')
      const bEditable = t.pageB.locator('docx-editor [contenteditable="true"]').first()
      await expect.poll(() => bEditable.textContent(), { timeout: 60000, intervals: [1000] }).toContain('w06-mark')
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('W0-7: 동시편집 중 첨부 삽입 → 리셋 후 양쪽 다 산다', async ({ browser }, testInfo) => {
    testInfo.setTimeout(420000)
    const f = await freshDocx('w07', 0)
    const t = await twoPages(browser)
    try {
      await openDocxEditing(t.pageA, f.rel)
      await openDocxEditing(t.pageB, f.rel)
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(2)
      await typeAtEnd(t.pageA, 'w07-mark')
      // 첨부 삽입 (앱 경로 그대로: officeEmbedFile 이벤트 → runOfficeEmbed).
      const xlsxBytes = fs.readFileSync(path.resolve('e2e/collab/fixtures/ole/embed-docx.xlsx'))
      const inserted = await t.pageA.evaluate(async (args: { bytes: number[]; hostPath: string; fname: string }) => {
        const blob = new Blob([new Uint8Array(args.bytes)], { type: 'application/octet-stream' })
        const file = new File([blob], args.fname, { type: 'application/octet-stream' })
        const done = new Promise<boolean>((resolve) => {
          const onDone = (e: Event) => {
            const d = (e as CustomEvent<{ path?: string }>).detail
            if (d && d.path === args.hostPath) {
              window.removeEventListener('officeEmbedDone', onDone as EventListener)
              resolve(true)
            }
          }
          window.addEventListener('officeEmbedDone', onDone as EventListener)
          setTimeout(() => resolve(false), 120000)
        })
        window.dispatchEvent(new CustomEvent('officeEmbedFile', { detail: { file, hostPath: args.hostPath } }))
        return done
      }, { bytes: Array.from(xlsxBytes), hostPath: f.rel.replace(/^repos\//, ''), fname: 'embed-docx.xlsx' })
      expect(inserted).toBe(true)
      // 방 리셋 후에도 양쪽 내용이 산다: 마크는 디스크에, 첨부 파트도 디스크에.
      await expect
        .poll(() => Promise.resolve(docxDiskHas(f.abs, 'w07-mark')), { timeout: 90000, intervals: [1000] })
        .toBe(true)
      const zip = await JSZip.loadAsync(fs.readFileSync(f.abs))
      expect(Object.keys(zip.files).some((n) => n.includes('embeddings/'))).toBe(true)
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('W0-8: Done은 탭 닫힘, 저장 실패는 탭 유지 + 내 사본', async ({ browser }, testInfo) => {
    testInfo.setTimeout(420000)
    const f = await freshDocx('w08', 0)
    const t = await twoPages(browser)
    try {
      await openDocxEditing(t.pageA, f.rel)
      await typeAtEnd(t.pageA, 'w08-mark')
      // 저장 실패 유도: /save 차단.
      await t.pageA.route('**/api/collab/save', async (route) => {
        await route.abort().catch(() => {})
      })
      const doneBtn = t.pageA.getByRole('button', { name: 'Done', exact: true }).first()
      if ((await doneBtn.count()) > 0) await doneBtn.click({ timeout: 20000 }).catch(() => {})
    // 실패해도 편집 화면에 남는다.
    await t.pageA.locator('docx-editor [contenteditable="true"]').first().waitFor({ timeout: 30000 })
    await expect(t.pageA.getByRole('button', { name: '내 사본 다운로드' })).toHaveCount(1, { timeout: 30000 })
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  // R-ribbon 후속: presence unmount/remount 때 슬롯에 껍데기가 쌓이지 않는지 본다.
  // 슬롯 안 shell 수/화면 avatar 수를 200ms마다 기록한다 (evaluate는 shadow를 못 뚫으므로 순회).
  async function watchTitlebarShell(page: Page): Promise<{ samples: string[]; stop: () => void }> {
    const samples: string[] = []
    const rec = setInterval(async () => {
      try {
        const s = await page.evaluate(() => {
          const all: Element[] = []
          const walk = (root: ParentNode) => {
            for (const el of Array.from(root.querySelectorAll('*'))) {
              all.push(el)
              const sr = (el as HTMLElement).shadowRoot
              if (sr) walk(sr)
            }
          }
          walk(document)
          const inSlot = (el: Element): boolean => {
            let p: Element | null = el
            while (p) {
              if (p.getAttribute && p.getAttribute('data-testid') === 'app-titlebar-slot') return true
              p = p.parentElement
            }
            return false
          }
          const shells = all.filter(
            (el) => el.getAttribute && el.getAttribute('data-testid') === 'collab-presence' && inSlot(el),
          ).length
          const peers = all.filter((el) => el.getAttribute && el.getAttribute('data-testid') === 'collab-peer').length
          return `${shells}/${peers}`
        })
        samples.push(s)
      } catch {
        /* 무시 */
      }
    }, 200)
    return { samples, stop: () => clearInterval(rec) }
  }

  async function assertNoShellPileup(samples: string[]): Promise<void> {
    // 슬롯에 shell이 2개 이상 쌓인 적이 없고, 비는 구간(0/)을 거쳐 1개로 복귀했다.
    const over = samples.filter((s) => Number(s.split('/')[0]) > 1)
    expect(over, `duplicate shells: ${samples.join(',')}`).toEqual([])
    expect(samples.some((s) => s.startsWith('0/')), `samples: ${samples.join(',')}`).toBe(true)
  }

  test('W0-9a: B가 offline됐다 돌아와도 타이틀바 presence는 1개를 유지한다', async ({ browser }, testInfo) => {
    // 순수 재연결 경로만 쓴다 (폴백 없음). D07: lastRxAt 기준 25초 무수신이면
    // 서버가 sweep으로 정리하므로, 30초 안에 참가자 수 감소가 관측되는 것이 정상이다.
    testInfo.setTimeout(420000)
    const f = await freshDocx('w09a', 0)
    const t = await twoPages(browser)
    const watch = await watchTitlebarShell(t.pageA)
    try {
      await openDocxEditing(t.pageA, f.rel)
      await openDocxEditing(t.pageB, f.rel)
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(2)
      await expect(t.pageA.locator('[data-testid="collab-presence"]')).toHaveCount(1, { timeout: 60000 })
      await t.ctxB.setOffline(true)
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(1)
      await t.ctxB.setOffline(false)
      // B 복귀: 참가자 2명 + 양쪽 presence 1개.
      await expect.poll(() => participantCount(f.name), { timeout: 90000, intervals: [1000] }).toBe(2)
      await expect(t.pageA.locator('[data-testid="collab-presence"]')).toHaveCount(1, { timeout: 60000 })
      await expect(t.pageB.locator('[data-testid="collab-presence"]')).toHaveCount(1, { timeout: 60000 })
    } finally {
      watch.stop()
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
    await assertNoShellPileup(watch.samples)
  })

  test('W0-9b: B가 나갔다 다시 열어도 타이틀바 presence는 1개를 유지한다', async ({ browser }, testInfo) => {
    // 이탈 후 재참가 경로 (W0-9a의 offline 전파와 별개).
    testInfo.setTimeout(420000)
    const f = await freshDocx('w09b', 0)
    const t = await twoPages(browser)
    const watch = await watchTitlebarShell(t.pageA)
    let ctxB: BrowserContext | null = null
    let pageB: Page = t.pageB
    try {
      await openDocxEditing(t.pageA, f.rel)
      await openDocxEditing(t.pageB, f.rel)
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(2)
      await expect(t.pageA.locator('[data-testid="collab-presence"]')).toHaveCount(1, { timeout: 60000 })
      await t.ctxB.close().catch(() => {})
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(1)
      ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(ctxB, GRACE)
      pageB = await ctxB.newPage()
      await gotoApp(pageB)
      await openDocxEditing(pageB, f.rel)
      // B 복귀: 참가자 2명 + 양쪽 presence 1개.
      await expect.poll(() => participantCount(f.name), { timeout: 60000, intervals: [1000] }).toBe(2)
      await expect(t.pageA.locator('[data-testid="collab-presence"]')).toHaveCount(1, { timeout: 60000 })
      await expect(pageB.locator('[data-testid="collab-presence"]')).toHaveCount(1, { timeout: 60000 })
    } finally {
      watch.stop()
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
      if (ctxB) await ctxB.close().catch(() => {})
    }
    await assertNoShellPileup(watch.samples)
  })
})
